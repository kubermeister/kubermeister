import { useEffect, useRef } from 'react';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, hoverTooltip, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import type { KindSchema } from '../../../shared/k8s/openapi';
import { completionsAt, describeAt } from '@/lib/manifest-completion';
import type { EditorDiagnostics } from '@/lib/manifest-diagnostics';
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
    '.cm-diagnostic': { fontFamily: 'var(--font-sans)', padding: '4px 8px' },
    '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
    '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
    '.cm-field-doc': { fontFamily: 'var(--font-sans)', maxWidth: '420px', padding: '6px 10px' },
    '.cm-field-doc-title': { fontFamily: 'var(--font-mono)', color: 'var(--primary)' },
    '.cm-field-doc-detail': { color: 'var(--text-muted)', marginLeft: '8px' },
    '.cm-field-doc-description': { marginTop: '4px', color: 'var(--text-2)', whiteSpace: 'pre-wrap' },
    '.cm-completionInfo': { fontFamily: 'var(--font-sans)', maxWidth: '420px', whiteSpace: 'pre-wrap' },
});

const editorHighlight = HighlightStyle.define([
    { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--primary)' },
    { tag: t.string, color: 'var(--ok)' },
    { tag: [t.number, t.bool, t.null], color: 'var(--warn)' },
    { tag: t.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
    { tag: [t.punctuation, t.separator, t.bracket, t.meta], color: 'var(--text-muted)' },
]);

/** Marks past the end of the document would throw; the text they belong to is checked first, so this is a backstop. */
function toDiagnostics(items: EditorDiagnostics['items'], length: number): Diagnostic[] {
    return items.map((item) => {
        const from = Math.min(item.from, length);
        return { from, to: Math.min(Math.max(item.to, from), length), severity: item.severity, message: item.message };
    });
}

/** A word being completed: a field name, or a value, which may carry dots, dashes and slashes. */
const COMPLETION_WORD = /^[\w.\-/]*$/;

/**
 * Completion and the description over a field, both from the kind's schema. The schema is read
 * through `schemaRef` at the moment each is asked for, so the one editor follows the kind the text
 * names as it changes, and offers nothing while there is none.
 */
function schemaExtensions(schemaRef: { current: KindSchema | null | undefined }) {
    const complete = (context: CompletionContext): CompletionResult | null => {
        const schema = schemaRef.current;
        if (!schema) return null;
        const found = completionsAt(context.state.doc.toString(), context.pos, schema);
        if (!found) return null;
        return {
            from: found.from,
            validFor: COMPLETION_WORD,
            options: found.options.map((option) => ({
                label: option.label,
                apply: option.apply,
                type: option.type,
                detail: option.detail || undefined,
                info: option.info,
                boost: option.boost,
            })),
        };
    };
    const describe = hoverTooltip((view, pos) => {
        const schema = schemaRef.current;
        const field = schema ? describeAt(view.state.doc.toString(), pos, schema) : null;
        if (!field) return null;
        return {
            pos: field.from,
            end: field.to,
            above: true,
            create: () => {
                const dom = document.createElement('div');
                dom.className = 'cm-field-doc';
                const title = dom.appendChild(document.createElement('span'));
                title.className = 'cm-field-doc-title';
                title.textContent = field.title;
                const detail = dom.appendChild(document.createElement('span'));
                detail.className = 'cm-field-doc-detail';
                detail.textContent = field.detail;
                if (field.description) {
                    const description = dom.appendChild(document.createElement('div'));
                    description.className = 'cm-field-doc-description';
                    description.textContent = field.description;
                }
                return { dom };
            },
        };
    });
    return [EditorState.languageData.of(() => [{ autocomplete: complete }]), describe];
}

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
    diagnostics,
    schema,
    'aria-label': ariaLabel,
}: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    className?: string;
    readOnly?: boolean;
    /**
     * Marks to show in the text, with the text they were found in. Passing the prop at all gives the
     * editor its gutter for them; null shows none.
     */
    diagnostics?: EditorDiagnostics | null;
    /**
     * The schema of the kind the text names, which completes fields and values and describes the
     * field under the pointer. Passing the prop at all turns both on; null offers nothing.
     */
    schema?: KindSchema | null;
    'aria-label'?: string;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    // Read once: the view is built a single time, so the mount effect has no reactive dependencies
    // and the change handler is always the latest one.
    const initialRef = useRef({
        value,
        placeholder,
        ariaLabel,
        readOnly,
        linted: diagnostics !== undefined,
        schemed: schema !== undefined,
    });
    const schemaRef = useRef(schema);
    const onChangeRef = useRef(onValueChange);
    const readOnlyCompartment = useRef(new Compartment());
    useEffect(() => {
        onChangeRef.current = onValueChange;
    }, [onValueChange]);
    useEffect(() => {
        schemaRef.current = schema;
    }, [schema]);

    useEffect(() => {
        const initial = initialRef.current;
        const view = new EditorView({
            doc: initial.value,
            parent: containerRef.current!,
            extensions: [
                basicSetup,
                keymap.of([indentWithTab]),
                initial.linted ? lintGutter() : [],
                initial.schemed ? schemaExtensions(schemaRef) : [],
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

    useEffect(() => {
        const view = viewRef.current;
        if (!view || diagnostics === undefined) return;
        // Marks found in an older text would sit at the wrong offsets; the ones already shown are
        // mapped through every edit by the editor itself until the check catches up.
        if (diagnostics && diagnostics.text !== view.state.doc.toString()) return;
        const items = toDiagnostics(diagnostics?.items ?? [], view.state.doc.length);
        view.dispatch(setDiagnostics(view.state, items));
    }, [diagnostics]);

    return <div ref={containerRef} className={cn('overflow-hidden bg-code-bg', className)} />;
}
