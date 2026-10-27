package net.mineandcraft.mapart;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.UUID;

final class BridgeClient {
    private static final Gson JSON = new Gson();
    private final URI origin;
    private final String key;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build();
    BridgeClient(String address, String key) {
        origin = URI.create(address);
        if (!"https".equals(origin.getScheme()) || origin.getHost() == null || origin.getUserInfo() != null || origin.getRawQuery() != null || origin.getFragment() != null || !(origin.getPath().isEmpty() || origin.getPath().equals("/"))) throw new IllegalArgumentException("Mapart site_origin must be an HTTPS origin");
        if (key == null || key.length() < 32 || key.length() > 256 || key.contains("\n") || key.contains("\r")) throw new IllegalArgumentException("Set MAPART_BRIDGE_KEY in the server environment");
        this.key = key;
    }
    record Download(byte[] bytes, String checksum) {}
    private Download request(String path, String method, byte[] body, String type, String lease, int maximum) throws Exception {
        if (!path.matches("/api/mapart/bridge/[a-z0-9/-]+/")) throw new IOException("Invalid bridge path");
        var builder = HttpRequest.newBuilder(origin.resolve(path)).timeout(Duration.ofSeconds(30)).header("Authorization", "Bearer " + key);
        if (path.equals("/api/mapart/bridge/lease/")) builder.header("X-Mapart-Max-Tiles", String.valueOf(Layout.MAX_TILES)).header("X-Mapart-Max-Side", String.valueOf(Layout.MAX_SIDE));
        if (lease != null) builder.header("X-Mapart-Lease", lease);
        if (body != null) builder.header("Content-Type", type);
        builder.method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        var response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
        try (var input = response.body()) {
            byte[] bytes = input.readNBytes(maximum + 1);
            if (bytes.length > maximum) throw new IOException("Mapart response exceeded its size limit");
            if (response.statusCode() / 100 != 2) throw new IOException("Mapart request failed (HTTP " + response.statusCode() + ")");
            return new Download(bytes, response.headers().firstValue("X-Content-SHA256").orElse(""));
        }
    }
    JsonObject json(String path, JsonObject body) throws Exception {
        return JSON.fromJson(new String(request(path, body == null ? "GET" : "POST", body == null ? null : JSON.toJson(body).getBytes(StandardCharsets.UTF_8), "application/json", null, 2 * 1024 * 1024).bytes, StandardCharsets.UTF_8), JsonObject.class);
    }
    Download source(String id, String lease) throws Exception { return request("/api/mapart/bridge/" + id + "/source/", "GET", null, null, lease, 5 * 1024 * 1024); }
    byte[] pixels(String path) throws Exception { return request(path, "GET", null, null, null, Layout.MAX_PIXEL_BYTES).bytes; }
    void failed(String id, String lease) throws Exception { request("/api/mapart/bridge/" + id + "/failed/", "POST", "{}".getBytes(StandardCharsets.UTF_8), "application/json", lease, 65536); }
    void result(String id, String lease, byte[] pixels, byte[] preview) throws Exception {
        String boundary = "mapart-" + UUID.randomUUID();
        var output = new ByteArrayOutputStream();
        part(output, boundary, "pixels", pixels, "application/octet-stream"); part(output, boundary, "preview", preview, "image/png");
        output.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        request("/api/mapart/bridge/" + id + "/result/", "POST", output.toByteArray(), "multipart/form-data; boundary=" + boundary, lease, 65536);
    }
    private static void part(ByteArrayOutputStream output, String boundary, String name, byte[] bytes, String type) throws IOException {
        output.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"; filename=\"" + name + "\"\r\nContent-Type: " + type + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(bytes); output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }
    static String checksum(byte[] bytes) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
}
