/**
 * Preset ids that asked to stay out of the picker.
 *
 * The mark is set by the binding that owns the preset (`hideFromRoster`), not
 * by a name list on the filter. New agents only need the same flag.
 */
const marked = new Set();
export function markRosterHidden(presetId) {
    const id = presetId.trim();
    if (id !== '')
        marked.add(id);
}
export function markedRosterIds() {
    return [...marked];
}
export function clearRosterMarks() {
    marked.clear();
}
