/**
 * How one agent's frames are shaped.
 *
 * The three agents we drive disagree in exactly the places a naive shared
 * projection gets wrong, so every field-reading decision lives here rather
 * than in the projection. Measured differences (2026-10-09):
 *
 *   tool name    grok  → update.title (first frame)
 *                codex → update.kind ("execute"; there is no tool name at all)
 *                claude→ update._meta.claudeCode.toolName
 *   tool output  grok/claude → update.content, nested twice
 *                codex        → update.rawOutput.formatted_output (no content)
 *   models       grok/codex → session/new .models.availableModels
 *                claude      → session/new .configOptions[id=model].options
 *   turn tokens  codex/claude → the session/prompt *response*'s `usage`
 *                grok        → nothing usable: only a running total on
 *                              session/update ._meta, which cannot be split
 *                              into the input/output pair a DSH usage needs
 */
export {};
