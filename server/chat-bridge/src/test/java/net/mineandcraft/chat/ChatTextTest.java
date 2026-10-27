package net.mineandcraft.chat;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ChatTextTest {
    @Test void notificationMatchesOnlyExactIgnRolesIgnoringCase() {
        assertTrue(ChatText.mentionedPlayer(java.util.List.of("ALEX"), "Alex"));
        assertTrue(ChatText.mentionedPlayer(java.util.List.of(".bedrock"), ".Bedrock"));
        assertFalse(ChatText.mentionedPlayer(java.util.List.of("Alex", "everyone"), "AlexTwo"));
        assertFalse(ChatText.mentionedPlayer(java.util.List.of("bedrock"), ".Bedrock"));
    }
    @Test void commandTextStaysLiteralAndControlsAreRemoved() {
        assertEquals("/op everyone", ChatText.plain("/op\neveryone§c", 100));
        assertEquals("[Discord] Alex: /op everyone", ChatText.lines("Alex", "/op everyone").getFirst());
    }
    @Test void splitsLongTextWithoutBreakingUnicode() {
        var lines = ChatText.lines("Alex", "😀".repeat(700));
        assertEquals(3, lines.size());
        assertEquals("😀".repeat(700), String.join("", lines).replace("[Discord] Alex: ", ""));
    }
    @Test void boundsSenderAndMessage() {
        assertEquals(64, ChatText.plain("x".repeat(100),64).length());
        assertTrue(ChatText.lines("Alex", "x".repeat(7000)).size() <= 25);
    }
}
