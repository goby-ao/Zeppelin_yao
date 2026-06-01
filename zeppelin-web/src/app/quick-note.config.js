export const QUICK_NOTE_ROOT = '快速笔记';

export const QUICK_NOTE_BINDINGS = {
  hive: 'hive',
  shell: 'sh',
};

export function getQuickNoteBinding(interpreter) {
  return QUICK_NOTE_BINDINGS[interpreter] || interpreter;
}
