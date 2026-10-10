using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

static class Program
{
    const int MAX_MSG = 60 * 1024;

    static object WriteLock = new object();

    static void Send(string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            if (b.Length > MAX_MSG) return;
            lock (WriteLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }
        catch { }
    }

    // Same comparison as the `exists` command: the extension is not part of the
    // identity, so a flac already on disk counts for the mp3 of the same name.
    static bool HasStem(string dir, string stem)
    {
        try
        {
            foreach (string f in Directory.GetFiles(dir))
            {
                if (string.Equals(Path.GetFileNameWithoutExtension(f), stem,
                                  StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        catch { }
        return false;
    }

    // Compare ignoring punctuation and spacing.
    //
    // Kugou is not stable about punctuation: the same track came back as
    // "远走高飞 (独唱版)" when it was downloaded and as "远走高飞（独唱版）)"
    // later, so an exact comparison reported 26 downloaded tracks as missing.
    // The set of characters kept here matches the normaliser the UI uses on the
    // other side of the wire: letters, digits, underscore and CJK.
    static bool IsKeyChar(char c)
    {
        if (c >= 'a' && c <= 'z') return true;
        if (c >= '0' && c <= '9') return true;
        if (c == '_') return true;
        if (c >= '\u4e00' && c <= '\u9fff') return true;
        if (c >= '\u3040' && c <= '\u30ff') return true;
        if (c >= '\uac00' && c <= '\ud7af') return true;
        return false;
    }

    static string LooseKey(string s)
    {
        var sb = new StringBuilder(s.Length);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c >= 'A' && c <= 'Z') c = (char)(c + 32);
            if (IsKeyChar(c)) sb.Append(c);
        }
        return sb.ToString();
    }

    static bool HasLooseStem(string dir, string want)
    {
        string k = LooseKey(want);
        if (k.Length == 0) return false;
        try
        {
            foreach (string f in Directory.GetFiles(dir))
            {
                if (LooseKey(Path.GetFileNameWithoutExtension(f)) == k) return true;
            }
        }
        catch { }
        return false;
    }

    static string fname2(string p)
    {
        try { return Path.GetFileName(p); } catch { return p; }
    }

    // Windows rejects these outright, and a trailing dot or space silently
    // truncates the name when the file is created. Song titles do contain
    // slashes and colons, so scrub rather than trust the caller.
    static string CleanName(string name)
    {
        if (string.IsNullOrEmpty(name)) return name;
        var sb = new StringBuilder(name.Length);
        char[] bad = new char[] { '<', '>', ':', '"', '/', '\\', '|', '?', '*' };
        for (int i = 0; i < name.Length; i++)
        {
            char c = name[i];
            if (Array.IndexOf(bad, c) >= 0) { sb.Append('_'); continue; }
            if (c < 32) { sb.Append('_'); continue; }
            sb.Append(c);
        }
        string outp = sb.ToString().TrimEnd(' ', '.');
        if (outp.Length == 0) outp = "unknown";
        if (outp.Length > 180) outp = outp.Substring(0, 180);
        return outp;
    }

    // id 原样回显：bridge 可能发数字也可能发字符串，
    // 若按 long 解析，字符串 id 会被静默吞成 0，
    // 回包就永远匹配不上 pending 表（表现为"10 秒未响应"）。
    static string IdJson(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return "0";
        raw = raw.Trim();
        if (raw.Length > 64) raw = raw.Substring(0, 64);
        bool numeric = raw.Length > 0;
        int digits = 0;
        for (int i = 0; i < raw.Length; i++)
        {
            if ((raw[i] == '-' || raw[i] == '+') && i == 0) continue;
            if (raw[i] >= '0' && raw[i] <= '9') { digits++; continue; }
            numeric = false;
            break;
        }
        if (numeric && digits > 0) return raw;
        return "\"" + Esc(raw) + "\"";
    }

    static void Reply(string id, bool ok, string msg, string path, long bytes)
    {
        Send("{\"id\":" + IdJson(id) + ",\"ok\":" + (ok ? "true" : "false")
             + ",\"msg\":\"" + Esc(msg) + "\""
             + ",\"path\":\"" + Esc(path) + "\""
             + ",\"bytes\":" + bytes + "}");
    }

    static string EvStart(string id) { return "{\"id\":" + IdJson(id) + ",\"event\":\"start\"}"; }

    static string EvProgress(string id, long received, long total, long pct)
    {
        return "{\"id\":" + IdJson(id) + ",\"event\":\"progress\",\"received\":" + received
             + ",\"total\":" + total + ",\"percent\":" + pct + "}";
    }

    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 32) sb.Append(' ');
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static string GetStr(Dictionary<string, string> d, string k, string def)
    {
        string v;
        return d.TryGetValue(k, out v) && v != null ? v : def;
    }

    /*
    A minimal JSON reader that actually understands nesting.

    The previous hand-rolled parser only walked top-level key/value pairs. The
    messages that arrive are wrapped:
        {"type":"message","payload":{"id":"...","cmd":"download",...}}
    so it read "payload" and swallowed the whole nested object as one opaque
    blob. Every real field -- id, cmd, url, dest -- came back missing, which
    is why the host logged "id=<none>" and no reply ever matched the pending
    request.

    This reader walks the text properly: it descends into objects and arrays,
    tracks nesting depth, and unescapes strings including \uXXXX. It also
    reads UTF-8 correctly, so CJK filenames survive. Before this, Chinese
    titles arrived as mojibake and got written out as garbage names.
*/

    class JsonVal
    {
        public string Str;
        public Dictionary<string, JsonVal> Obj;
        public List<JsonVal> Arr;
    }

    class JsonReader
    {
        readonly string s;
        int i;

        public JsonReader(string text) { s = text; i = 0; }

        public JsonVal Read()
        {
            SkipWs();
            return ReadValue();
        }

        void SkipWs()
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        JsonVal ReadValue()
        {
            SkipWs();
            if (i >= s.Length) return null;
            char c = s[i];
            if (c == '{') return ReadObject();
            if (c == '[') return ReadArray();
            if (c == '"')
            {
                var v = new JsonVal();
                v.Str = ReadString();
                return v;
            }
            // bare literal: number, true, false, null
            int start = i;
            while (i < s.Length && s[i] != ',' && s[i] != '}' && s[i] != ']'
                   && s[i] != ' ' && s[i] != '\t' && s[i] != '\r' && s[i] != '\n') i++;
            var lit = new JsonVal();
            lit.Str = s.Substring(start, i - start);
            return lit;
        }

        JsonVal ReadObject()
        {
            var v = new JsonVal();
            v.Obj = new Dictionary<string, JsonVal>();
            i++;   // past '{'
            while (i < s.Length)
            {
                SkipWs();
                if (i >= s.Length) break;
                if (s[i] == '}') { i++; break; }
                if (s[i] == ',') { i++; continue; }
                if (s[i] != '"') { i++; continue; }   // skip junk
                string key = ReadString();
                SkipWs();
                if (i < s.Length && s[i] == ':') i++;
                JsonVal child = ReadValue();
                v.Obj[key] = child;
            }
            return v;
        }

        JsonVal ReadArray()
        {
            var v = new JsonVal();
            v.Arr = new List<JsonVal>();
            i++;   // past '['
            while (i < s.Length)
            {
                SkipWs();
                if (i >= s.Length) break;
                if (s[i] == ']') { i++; break; }
                if (s[i] == ',') { i++; continue; }
                v.Arr.Add(ReadValue());
            }
            return v;
        }

        string ReadString()
        {
            var sb = new StringBuilder();
            i++;   // past opening quote
            while (i < s.Length)
            {
                char c = s[i];
                if (c == '"') { i++; break; }
                if (c == '\\' && i + 1 < s.Length)
                {
                    char e = s[i + 1];
                    if (e == 'n') { sb.Append('\n'); i += 2; continue; }
                    if (e == 'r') { sb.Append('\r'); i += 2; continue; }
                    if (e == 't') { sb.Append('\t'); i += 2; continue; }
                    if (e == 'b') { sb.Append('\b'); i += 2; continue; }
                    if (e == 'f') { sb.Append('\f'); i += 2; continue; }
                    if (e == 'u' && i + 5 < s.Length)
                    {
                        int cp;
                        if (int.TryParse(s.Substring(i + 2, 4),
                                NumberStyles.HexNumber, CultureInfo.InvariantCulture, out cp))
                        {
                            sb.Append((char)cp);
                            i += 6;
                            continue;
                        }
                    }
                    if (e == '\\') { sb.Append('\\'); i += 2; continue; }
                    if (e == '"') { sb.Append('"'); i += 2; continue; }
                    if (e == '/') { sb.Append('/'); i += 2; continue; }
                    sb.Append(e);
                    i += 2;
                    continue;
                }
                sb.Append(c);
                i++;
            }
            return sb.ToString();
        }
    }

    static JsonVal Find(JsonVal root, string key)
    {
        if (root == null || root.Obj == null) return null;
        JsonVal v;
        return root.Obj.TryGetValue(key, out v) ? v : null;
    }

    static string StrOf(JsonVal v)
    {
        if (v == null) return "";
        if (v.Str != null) return v.Str;
        return "";
    }

    // Turn transport exceptions into something worth showing a user. A bare
    // "远程服务器返回错误: (403) 已禁止。" does not say WHICH stage failed or
    // that it was retried three times.
    static string Describe(Exception ex)
    {
        try
        {
            var wex = ex as WebException;
            if (wex != null)
            {
                var hr = wex.Response as HttpWebResponse;
                if (hr != null)
                {
                    int code = (int)hr.StatusCode;
                    string why;
                    switch (code)
                    {
                        case 403: why = "无访问权限（该曲目需要会员或受地区限制）"; break;
                        case 404: why = "地址已失效（重新取流再试）"; break;
                        case 416: why = "地址范围无效"; break;
                        case 429: why = "请求过于频繁，被限流"; break;
                        case 503: why = "服务器繁忙"; break;
                        default: why = hr.StatusDescription; break;
                    }
                    hr.Close();
                    return "HTTP " + code + " " + (why == null ? "" : why);
                }
                switch (wex.Status)
                {
                    case WebExceptionStatus.Timeout: return "连接超时";
                    case WebExceptionStatus.ConnectFailure: return "连不上服务器";
                    case WebExceptionStatus.ReceiveFailure: return "接收中断";
                    case WebExceptionStatus.SendFailure: return "发送失败";
                    case WebExceptionStatus.NameResolutionFailure: return "域名解析失败";
                    case WebExceptionStatus.TrustFailure: return "证书校验失败";
                    default: return wex.Message;
                }
            }
            if (ex is IOException) return "网络中断: " + ex.Message;
            return ex.Message;
        }
        catch { return ex.Message; }
    }

    static void HostLog(string msg)
    {
        try
        {
            string dir = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData) + "\\moekoemusic";
            string p = dir + "\\_odl_host_debug.log";
            FileStream fs = new FileStream(p, FileMode.Append, FileAccess.Write,
                                           FileShare.ReadWrite | FileShare.Delete);
            try
            {
                var bytes = Encoding.UTF8.GetBytes(
                    "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + msg + Environment.NewLine);
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush();
            }
            finally { fs.Dispose(); }
        }
        catch { }
    }

    static void Main()
    {
        // The bridge writes UTF-8. Without this the console decodes with the
        // system codepage (GBK here), turning every CJK filename into mojibake.
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        try { Console.InputEncoding = new UTF8Encoding(false); } catch { }

        Send("{\"type\":\"hello\",\"host\":\"offline-dl-saver\"}");
        HostLog("HOST STARTED pid=" + Process.GetCurrentProcess().Id);

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line.Length > 900) HostLog("STDIN(long) " + line.Substring(0, 900));
            else HostLog("STDIN " + line);

            JsonVal root;
            try { root = new JsonReader(line).Read(); }
            catch (Exception ex)
            {
                HostLog("  !! JSON parse failed: " + ex.Message);
                continue;
            }

            // Messages arrive wrapped: {"type":"message","payload":{...}}
            // Take the payload when present, otherwise read the top level.
            JsonVal body = Find(root, "payload");
            if (body == null || body.Obj == null) body = root;

            string id = StrOf(Find(body, "id"));
            string cmd = StrOf(Find(body, "cmd"));
            HostLog("  -> cmd=" + cmd + " id=" + (string.IsNullOrEmpty(id) ? "<none>" : id));

            try
            {
                if (cmd == "ping")
                {
                    Reply(id, true, "pong", "", 0);
                }
                else if (cmd == "download")
                {
                    string url = StrOf(Find(body, "url"));
                    string dest = StrOf(Find(body, "dest"));
                    string dir = StrOf(Find(body, "dir"));

                    if (string.IsNullOrEmpty(dest))
                    {
                        Reply(id, false, "dest 不能为空", "", 0);
                        continue;
                    }
                    dest = CleanName(dest);

                    if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
                    {
                        try { Directory.CreateDirectory(dir); }
                        catch (Exception ex)
                        {
                            Reply(id, false, "建目录失败: " + ex.Message, "", 0);
                            continue;
                        }
                    }

                    string full = Path.IsPathRooted(dest) ? dest : Path.Combine(dir ?? "", dest);
                    string dirn = Path.GetDirectoryName(full);
                    if (!string.IsNullOrEmpty(dirn) && !Directory.Exists(dirn))
                    {
                        try { Directory.CreateDirectory(dirn); }
                        catch (Exception ex)
                        {
                            Reply(id, false, "建目录失败: " + ex.Message, "", 0);
                            continue;
                        }
                    }

                    Send(EvStart(id));

                    // Write to a sidecar first and rename on success. Writing
                    // straight to the target means a crash mid-transfer leaves
                    // a truncated file that looks complete on the next run --
                    // and the next run then happily "skips" it.
                    string part = full + ".part";
                    try { if (File.Exists(part)) File.Delete(part); } catch { }

                    long total = 0;
                    bool ok = false;
                    string lastErr = "";

                    for (int attempt = 1; attempt <= 3 && !ok; attempt++)
                    {
                        total = 0;
                        try
                        {
                            if (attempt > 1)
                            {
                                // Keep the bridge's 20 s silence watchdog alive
                                // across a retry so the request is not declared
                                // dead while we are still working.
                                Send(EvProgress(id, 0, 0, 0));
                                HostLog("  retry " + attempt + "/3 for " + id);
                                Thread.Sleep(600 * attempt);
                            }

                            ServicePointManager.SecurityProtocol =
                                SecurityProtocolType.Tls12 | SecurityProtocolType.Tls11 | SecurityProtocolType.Tls;
                            ServicePointManager.DefaultConnectionLimit = 16;

                            // The CDN rejects bare requests, so send browser
                            // headers. Accept / Referer are restricted headers
                            // and throw on manual Set, hence the try wrappers.
                            var req = (HttpWebRequest)WebRequest.Create(url);
                            req.UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                                         + "(KHTML, like Gecko) Chrome/126.0 Safari/537.36";
                            try { req.Headers["Accept-Language"] = "zh-CN,zh;q=0.9"; } catch { }
                            try { req.Referer = "http://www.kugou.com/"; } catch { }
                            req.AutomaticDecompression = DecompressionMethods.None;
                            req.KeepAlive = false;
                            req.Timeout = 20000;
                            // 15 s, not the 2 minutes it used to be. A stalled
                            // read must fail fast so the retry loop can recover;
                            // hanging for two minutes only let the UI time out
                            // first and left a half-written file behind.
                            req.ReadWriteTimeout = 15000;
                            req.AllowAutoRedirect = true;
                            req.MaximumAutomaticRedirections = 8;

                            HttpWebResponse resp;
                            try
                            {
                                resp = (HttpWebResponse)req.GetResponse();
                            }
                            catch (WebException wex)
                            {
                                var hr = wex.Response as HttpWebResponse;
                                if (hr != null)
                                {
                                    lastErr = "HTTP " + (int)hr.StatusCode + " " + hr.StatusCode;
                                    hr.Close();
                                }
                                else lastErr = wex.Message;
                                throw;
                            }

                            long declared = resp.ContentLength;
                            Send(EvProgress(id, 0, declared, 0));

                            using (var rs = resp.GetResponseStream())
                            using (var fs = new FileStream(part, FileMode.Create, FileAccess.Write,
                                                          FileShare.None, 65536))
                            {
                                byte[] buf = new byte[65536];
                                int n;
                                long lastReport = 0;
                                long lastClock = 0;
                                var clock = Stopwatch.StartNew();
                                while ((n = rs.Read(buf, 0, buf.Length)) > 0)
                                {
                                    fs.Write(buf, 0, n);
                                    total += n;
                                    if (total - lastReport >= 262144 || clock.ElapsedMilliseconds - lastClock >= 400)
                                    {
                                        lastReport = total;
                                        lastClock = clock.ElapsedMilliseconds;
                                        long pct = declared > 0 ? (total * 100 / declared) : 0;
                                        Send(EvProgress(id, total, declared, pct));
                                    }
                                }
                                fs.Flush();
                            }
                            resp.Close();

                            // A short read against a declared length means the
                            // stream was cut. Do not pass it off as complete.
                            if (declared > 0 && total < declared)
                                throw new IOException("连接中断，只收到 " + total + "/" + declared + " 字节");

                            try { if (File.Exists(full)) File.Delete(full); } catch { }
                            File.Move(part, full);
                            ok = true;
                            Send(EvProgress(id, total, declared > 0 ? declared : total, 100));
                        }
                        catch (Exception ex)
                        {
                            lastErr = Describe(ex);
                            HostLog("  attempt " + attempt + " failed: " + lastErr);
                            try { if (File.Exists(part)) File.Delete(part); } catch { }
                        }
                    }

                    if (!ok)
                    {
                        Reply(id, false, "下载失败（重试 3 次）: " + lastErr, "", total);
                        continue;
                    }

                    if (total == 0)
                    {
                        try { File.Delete(full); } catch { }
                        Reply(id, false, "下载内容为空", "", 0);
                        continue;
                    }

                    Reply(id, true, "ok", full, total);
                    HostLog("DONE " + fname2(full) + " bytes=" + total);
                }
                else if (cmd == "ping_all")
                {
                    Reply(id, true, "pong", "", 0);
                }
                else if (cmd == "check")
                {
                    // Membership over a batch of candidate names.
                    //
                    // Returning the whole folder in one reply was the obvious
                    // design and it does not survive contact with the app: a
                    // few hundred CJK filenames come to ~17 KB and the reply
                    // never arrives, so the caller only sees a silent timeout.
                    // Small batches keep both directions well under whatever
                    // the transport actually accepts.
                    string cDir = StrOf(Find(body, "dir"));
                    JsonVal names = Find(body, "names");
                    var hits = new StringBuilder("[");
                    int n = 0;
                    bool okDir = !string.IsNullOrEmpty(cDir) && Directory.Exists(cDir);
                    if (okDir && names != null && names.Arr != null)
                    {
                        for (int i = 0; i < names.Arr.Count && n < 200; i++)
                        {
                            string want = StrOf(names.Arr[i]);
                            if (string.IsNullOrEmpty(want)) continue;
                            if (!HasLooseStem(cDir, want)) continue;
                            if (n > 0) hits.Append(',');
                            hits.Append(i);
                            n++;
                        }
                    }
                    hits.Append(']');
                    Send("{\"id\":" + IdJson(id) + ",\"ok\":true,\"have\":" + hits + "}");
                }
                else if (cmd == "exists")
                {
                    // Ask the host, not a browser-side cache. Only the process
                    // that owns the folder can say for sure what is in it, and
                    // an index in localStorage is exactly the sort of thing
                    // that gets cleared and then quietly re-downloads
                    // gigabytes the user already has on disk.
                    //
                    // Matched by stem, ignoring the extension: the question
                    // being asked is "is this track already in the folder",
                    // and the container depends on which bitrate was fetched.
                    // Callers that want a specific container re-fetching at a
                    // different quality just un-tick the skip checkbox.
                    string exDir = StrOf(Find(body, "dir"));
                    string exName = CleanName(StrOf(Find(body, "dest")));
                    bool found = false;
                    if (!string.IsNullOrEmpty(exDir) && !string.IsNullOrEmpty(exName))
                    {
                        try
                        {
                            string stem = Path.GetFileNameWithoutExtension(exName);
                            if (Directory.Exists(exDir))
                            {
                                // Compared by hand rather than with
                                // Directory.GetFiles(stem + ".*"): a stem
                                // containing [ ] ? or * is a glob to GetFiles
                                // and would match the wrong file.
                                foreach (string f in Directory.GetFiles(exDir))
                                {
                                    if (string.Equals(
                                            Path.GetFileNameWithoutExtension(f),
                                            stem, StringComparison.OrdinalIgnoreCase))
                                    {
                                        found = true;
                                        break;
                                    }
                                }
                            }
                        }
                        catch { found = false; }
                    }
                    Send("{\"id\":" + IdJson(id) + ",\"ok\":true,\"exists\":" +
                         (found ? "true" : "false") + "}");
                }
                else
                {
                    Reply(id, false, "未知命令: " + cmd, "", 0);
                }
            }
            catch (Exception ex)
            {
                Reply(id, false, ex.Message, "", 0);
            }
        }
    }
}