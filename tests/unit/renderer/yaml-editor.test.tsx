import { render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

const { YamlEditor } = await import('@/components/data-display/yaml-editor');

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector<HTMLElement>('.cm-editor')!)!;

describe('yaml editor', () => {
    it('reports what is typed and never echoes a value the parent handed it', async () => {
        const onValueChange = vi.fn();
        const { container, rerender } = render(<YamlEditor value={'a: 1\n'} onValueChange={onValueChange} />);

        rerender(<YamlEditor value={'a: 2\n'} onValueChange={onValueChange} />);
        await waitFor(() => expect(viewOf(container).state.doc.toString()).toBe('a: 2\n'));
        expect(onValueChange).not.toHaveBeenCalled();

        viewOf(container).dispatch({ changes: { from: 3, to: 4, insert: '3' } });
        expect(onValueChange).toHaveBeenCalledExactlyOnceWith('a: 3\n');
    });
});
