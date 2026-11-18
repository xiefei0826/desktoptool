<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap
} from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { MySQL, PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql'
import { tags } from '@lezer/highlight'

const props = defineProps<{
  modelValue: string
  dialect: 'mysql' | 'postgres'
  schema: Record<string, Record<string, string[]>>
  placeholder?: string
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
  (event: 'execute'): void
  (event: 'format'): void
}>()

const host = ref<HTMLDivElement | null>(null)
const menu = ref<{ x: number; y: number } | null>(null)
const languageCompartment = new Compartment()

let view: EditorView | null = null

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--sql-keyword, #7aa2ff)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--sql-string, #8bd48b)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--sql-number, #e0b45c)' },
  { tag: tags.comment, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--text-dim)' },
  { tag: [tags.typeName, tags.className], color: 'var(--sql-type, #4fd1c5)' },
  { tag: tags.propertyName, color: 'var(--sql-property, #c08bff)' }
])

function languageSupport(): ReturnType<typeof sql> {
  return sql({
    dialect: props.dialect === 'mysql' ? MySQL : PostgreSQL,
    schema: props.schema as SQLNamespace,
    upperCaseKeywords: true
  })
}

onMounted(() => {
  if (!host.value) return

  view = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        closeBrackets(),
        autocompletion(),
        syntaxHighlighting(highlightStyle),
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              emit('execute')
              return true
            }
          },
          {
            key: 'F5',
            run: () => {
              emit('execute')
              return true
            }
          },
          {
            key: 'Mod-Shift-f',
            run: () => {
              emit('format')
              return true
            }
          },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab
        ]),
        languageCompartment.of(languageSupport()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        }),
        EditorView.contentAttributes.of({
          'aria-label': 'SQL 编辑器',
          spellcheck: 'false'
        }),
        EditorView.theme({
          '&': {
            height: '100%',
            fontSize: '12.5px',
            backgroundColor: 'var(--bg)',
            color: 'var(--text)'
          },
          '.cm-scroller': {
            fontFamily: "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
            lineHeight: '1.6'
          },
          '.cm-content': { padding: '8px 0' },
          '.cm-gutters': {
            backgroundColor: 'var(--panel)',
            color: 'var(--muted)',
            border: 'none'
          },
          '.cm-activeLine': { backgroundColor: 'var(--panel-2)' },
          '.cm-activeLineGutter': { backgroundColor: 'var(--panel-2)' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
            backgroundColor: 'var(--accent-soft)'
          },
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
          '.cm-tooltip': {
            backgroundColor: 'var(--panel)',
            border: '1px solid var(--border)',
            color: 'var(--text)'
          },
          '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
            backgroundColor: 'var(--accent-soft)',
            color: 'var(--text)'
          }
        })
      ]
    }),
    parent: host.value
  })
})

watch(
  () => [props.dialect, props.schema],
  () => {
    view?.dispatch({ effects: languageCompartment.reconfigure(languageSupport()) })
  },
  { deep: true }
)

watch(
  () => props.modelValue,
  (value) => {
    if (!view) return
    if (value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }
)

function selectionText(): string {
  if (!view) return ''
  const { from, to } = view.state.selection.main
  return from === to ? '' : view.state.sliceDoc(from, to)
}

function deleteSelection(): void {
  if (!view) return
  const { from, to } = view.state.selection.main
  if (from === to) return
  view.dispatch({ changes: { from, to, insert: '' } })
  view.focus()
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault()
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 280)
  }
}

function closeMenu(): void {
  menu.value = null
}

async function copySelection(): Promise<void> {
  const text = selectionText()
  closeMenu()
  if (!text) return
  await window.api.clipboard.write(text)
}

async function cutSelection(): Promise<void> {
  const text = selectionText()
  closeMenu()
  if (!text) return
  await window.api.clipboard.write(text)
  deleteSelection()
}

async function pasteAtCursor(): Promise<void> {
  closeMenu()
  const text = await window.api.clipboard.read()
  if (!text || !view) return
  view.dispatch(view.state.replaceSelection(text))
  view.focus()
}

function selectAll(): void {
  closeMenu()
  if (!view) return
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
  view.focus()
}

function runCurrent(): void {
  closeMenu()
  emit('execute')
}

function formatCurrent(): void {
  closeMenu()
  emit('format')
}

onMounted(() => {
  window.addEventListener('click', closeMenu)
})

onBeforeUnmount(() => {
  window.removeEventListener('click', closeMenu)
  view?.destroy()
  view = null
})

defineExpose({
  getValue: (): string => view?.state.doc.toString() ?? '',
  getSelection: (): string => {
    if (!view) return ''
    const { from, to } = view.state.selection.main
    return from === to ? '' : view.state.sliceDoc(from, to)
  },
  focus: (): void => view?.focus(),
  getCursor: (): number => view?.state.selection.main.head ?? 0,
  setSelection: (from: number, to: number): void => {
    if (!view) return
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
    view.focus()
  },
  replaceSelection: (text: string): void => {
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
  },
  insertText: (text: string): void => {
    if (!view) return
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    view.focus()
  }
})
</script>

<template>
  <div ref="host" class="sql-editor" @contextmenu.prevent="onContextMenu" />

  <div
    v-if="menu"
    class="ctx-menu"
    :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
    @click.stop
  >
    <button @click="runCurrent">执行选中 / 当前语句</button>
    <button @click="formatCurrent">格式化选中</button>
    <div class="ctx-sep" />
    <button @click="copySelection">复制</button>
    <button @click="cutSelection">剪切</button>
    <button @click="pasteAtCursor">粘贴</button>
    <button @click="selectAll">全选</button>
  </div>
</template>

<style scoped>
.sql-editor {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.sql-editor :deep(.cm-editor) {
  height: 100%;
}

.sql-editor :deep(.cm-editor.cm-focused) {
  outline: none;
}

.ctx-menu {
  position: fixed;
  z-index: 900;
  min-width: 176px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}

.ctx-menu button {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.ctx-menu button:hover {
  background: var(--accent-soft);
  color: var(--text);
}

.ctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-soft);
}
</style>
