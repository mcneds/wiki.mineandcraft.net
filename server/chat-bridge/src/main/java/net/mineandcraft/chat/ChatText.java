package net.mineandcraft.chat;

import java.util.ArrayList;
import java.util.List;

final class ChatText {
    private ChatText() {}
    static String plain(String value, int maximum) {
        String cleaned = value.replaceAll("§.", "").replaceAll("[\\p{Cc}\\p{Cf}]", " ").replaceAll("\\s+", " ").strip();
        if (cleaned.codePointCount(0, cleaned.length()) <= maximum) return cleaned;
        return cleaned.substring(0, cleaned.offsetByCodePoints(0, maximum - 1)) + "…";
    }
    static List<String> lines(String sender, String text) {
        String prefix = "[Discord] " + plain(sender, 64) + ": ";
        String remaining = plain(text, 6000);
        var result = new ArrayList<String>();
        while (!remaining.isEmpty()) {
            int end = remaining.offsetByCodePoints(0, Math.min(240, remaining.codePointCount(0, remaining.length())));
            if (end < remaining.length()) {
                int space = remaining.lastIndexOf(' ', end);
                if (space > 0) end = space;
            }
            result.add(prefix + remaining.substring(0, end));
            remaining = remaining.substring(end).stripLeading();
        }
        return result;
    }
    static boolean mentionedPlayer(List<String> roles, String inGameName) {
        return roles.stream().anyMatch(name -> name.equalsIgnoreCase(inGameName));
    }
}
