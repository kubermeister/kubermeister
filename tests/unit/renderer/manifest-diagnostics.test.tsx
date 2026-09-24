import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KindSchema } from '../../../src/shared/k8s/openapi';
import { renderWithQuery } from './helpers';

const invoke = vi.fn();
vi.mock('@/lib/ipc', async () => ({ ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')), invoke }));

const { YamlEditor } = await import('@/components/data-display/yaml-editor');
const { useManifestChecks } = await import('@/lib/manifest-diagnostics');
const { startCompletion, currentCompletions } = await import('@codemirror/autocomplete');
const { EditorView } = await import('@codemirror/view');

const configMapSchema: KindSchema = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    document: 'api/v1',
    name: 'io.k8s.api.core.v1.ConfigMap',
    definitions: {
        'io.k8s.api.core.v1.ConfigMap': {
            type: 'object',
            properties: {
                apiVersion: { type: 'string' },
                kind: { type: 'string' },
                metadata: { type: 'object', properties: { name: { type: 'string' } } },
                data: { type: 'object', additionalProperties: { type: 'string' } },
            },
        },
    },
};

const MANIFEST = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata:\n  port: 8080\n';

function Checked({ text, enabled = true }: { text: string; enabled?: boolean }) {
    const { diagnostics, schema } = useManifestChecks(text, enabled);
    return <YamlEditor value={text} onValueChange={() => {}} diagnostics={diagnostics} schema={schema} />;
}

const marked = (container: HTMLElement, severity: 'error' | 'warning') =>
    [...container.querySelectorAll(`.cm-lintRange-${severity}`)].map((mark) => mark.textContent);

describe('checking a manifest in the editor', () => {
    beforeEach(() => {
        invoke.mockReset();
        invoke.mockImplementation(async (channel: string) => (channel === 'schemas.forKind' ? configMapSchema : null));
    });

    it('marks what the schema of the kind it names refuses, asking main for that kind only', async () => {
        const { container } = renderWithQuery(<Checked text={MANIFEST} />);
        await waitFor(() => expect(marked(container, 'error')).toEqual(['8080']));
        expect(invoke).toHaveBeenCalledWith('schemas.forKind', { apiVersion: 'v1', kind: 'ConfigMap' });
    });

    it('still marks what main refuses when the cluster publishes no schema for the kind', async () => {
        invoke.mockImplementation(async () => null);
        const { container } = renderWithQuery(<Checked text={'apiVersion: v1\nkind: ConfigMap\nmetadata: {}\n'} />);
        await waitFor(() => expect(marked(container, 'error')).toEqual(['metadata']));
        expect(container.querySelector('.cm-gutter-lint')).not.toBeNull();
    });

    it('checks nothing and asks nothing while it is turned off', async () => {
        const { container } = renderWithQuery(<Checked text={MANIFEST} enabled={false} />);
        await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
        expect(marked(container, 'error')).toEqual([]);
        expect(invoke).not.toHaveBeenCalled();
    });

    it('completes the fields of the mapping at the cursor from the same schema', async () => {
        const text = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\nd';
        const { container } = renderWithQuery(<Checked text={text} />);
        await waitFor(() => expect(invoke).toHaveBeenCalledWith('schemas.forKind', expect.anything()));
        const content = container.querySelector('.cm-content') as HTMLElement;
        const view = EditorView.findFromDOM(content);
        expect(view).not.toBeNull();
        view!.focus();
        view!.dispatch({ selection: { anchor: text.length } });
        // The schema reaches the editor a render after the query answers; completion reads it then.
        await waitFor(() => {
            startCompletion(view!);
            return new Promise((resolve) => setTimeout(resolve, 150)).then(() =>
                expect(currentCompletions(view!.state).map((option) => option.label)).toEqual(['data']),
            );
        });
    });

    it('never places marks found in an older text', async () => {
        const stale = { text: 'something else', items: [{ from: 0, to: 5, severity: 'error' as const, message: 'x' }] };
        const { container } = renderWithQuery(
            <YamlEditor value={MANIFEST} onValueChange={() => {}} diagnostics={stale} />,
        );
        await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
        expect(marked(container, 'error')).toEqual([]);
    });

    it('has no gutter for marks where nobody asked for them', async () => {
        const { container } = renderWithQuery(<YamlEditor value={MANIFEST} onValueChange={() => {}} />);
        await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
        expect(container.querySelector('.cm-gutter-lint')).toBeNull();
    });
});
