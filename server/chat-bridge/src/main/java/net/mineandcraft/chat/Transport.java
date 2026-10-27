package net.mineandcraft.chat;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

final class Transport implements AutoCloseable {
    private static final Gson JSON = new Gson();
    private final String key;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).followRedirects(HttpClient.Redirect.NEVER).build();
    Transport(String key) {
        if (key == null || !key.matches("[A-Za-z0-9_-]{32,256}")) throw new IllegalArgumentException("Invalid private chat key");
        this.key = key;
    }
    record Reply(int status, JsonObject body) {}
    Reply request(String path, JsonObject body) throws Exception {
        if (!path.matches("/bridge/(poll\\?session=[a-f0-9-]+&players=[0-9]+|events|ack|directory)")) throw new IllegalArgumentException("Invalid chat path");
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:25586" + path)).timeout(Duration.ofSeconds(3)).header("Authorization", "Bearer " + key);
        if (body != null) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(JSON.toJson(body)));
        var response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
        if (response.body().length() > 512000) throw new IOException("Oversized chat response");
        return new Reply(response.statusCode(), response.statusCode() == 200 ? JSON.fromJson(response.body(), JsonObject.class) : new JsonObject());
    }
    @Override public void close() { client.shutdownNow(); }
}
