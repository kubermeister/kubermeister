import { useEffect, useRef } from 'react';
import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { cn } from '@/lib/utils';

/**
 * The editor chrome expressed in the app's own CSS tokens, so it follows the theme toggle without
 * being rebuilt when the root class flips.
 */
const editorTheme = EditorView.theme({
    '&': {
        height: '100%',
        backgroundColor: 'transparent',
        color: 'var(--text-2)',
        fontSize: 'var(--text-cell)',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
    '.cm-content': { caretColor: 'var(--foreground)', padding: '14px 10px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'color-mix(in srgb, var(--primary) 25%, transparent)',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--primary) 6%, transparent)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-dim)', border: 'none' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
    '.cm-placeholder': { color: 'var(--text-dim)' },
    '.cm-panels': { backgroundColor: 'var(--elev-2)', color: 'var(--foreground)' },
    '.cm-panels input, .cm-panels button': { color: 'var(--foreground)' },
    '.cm-tooltip': { backgroundColor: 'var(--elev-2)', color: 'var(--foreground)', border: '1px solid var(--border)' },
});

const editorHighlight = HighlightStyle.define([
    { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--primary)' },
    { tag: t.string, color: 'var(--ok)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--warn)' },
    { tag: t.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
    { tag: [t.punctuation, t.separator, t.bracket, t.meta], color: 'var(--text-muted)' },
]);

/** Swapped through the compartment as `readOnly` flips, so the view is never rebuilt. */
function readOnlyExtensions(readOnly: boolean) {
    return readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
}

/**
 * A YAML editor on CodeMirror 6: real parsing, line numbers, bracket matching and in-editor search,
 * plus tab indentation. Controlled, so an external change to `value` replaces the document in
 * place. Read-only keeps the whole viewer (selection, search, scrolling) and only rejects edits.
 */
export function YamlEditor({
    value,
    onValueChange,
    placeholder,
    className,
    readOnly = false,
    'aria-label': ariaLabel,
}: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    readOnly?: boolean;
    'aria-label'?: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Read once: the view is built a single time, so the mount effect has no reactive dependencies
    // and the change handler is always the latest one.
    const initialRef = useRef({ value, placeholder, ariaLabel, readOnly });
    const onChangeRef = useRef(onValueChange);
    const readOnlyCompartment = useRef(new Compartment());
    useEffect(() => {
        onChangeRef.current = onValueChange;
    }, [onValueChange]);

    useEffect(() => {
        const initial = initialRef.current;
        const view = new EditorView({
            doc: initial.value,
            parent: containerRef.current!,
            extensions: [
                basicSetup,
                keymap.of([indentWithTab]),
                yaml(),
                editorTheme,
                syntaxHighlighting(editorHighlight),
                cmPlaceholder(initial.placeholder ?? ''),
                // A dropped file belongs to the app, not to this editor: CodeMirror's own handler
                // would read it in the renderer and paste it at the drop position, while the window
                // handler has main read it and replace the document. Text dropped in is still the
                // editor's own business.
                EditorView.domEventHandlers({ drop: (event) => !!event.dataTransfer?.files.length }),
                readOnlyCompartment.current.of(readOnlyExtensions(initial.readOnly)),
                EditorView.contentAttributes.of({ 'aria-label': initial.ariaLabel ?? 'Code editor' }),
                EditorView.updateListener.of((update) => {
                    if (update.docChanged) onChangeRef.current(update.state.doc.toString());
                }),
            ],
        });
        viewRef.current = view;
        return () => {
            viewRef.current = null;
            view.destroy();
        };
    }, []);

    useEffect(() => {
        viewRef.current?.dispatch({ effects: readOnlyCompartment.current.reconfigure(readOnlyExtensions(readOnly)) });
    }, [readOnly]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }, [value]);

    return <div ref={containerRef} className={cn('overflow-hidden bg-code-bg', className)} />;
}
