import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithQuery } from './helpers';
import { ManifestReview } from '@/components/templates/manifest-review';

const LIVE = ['kind: ConfigMap', 'metadata:', '  name: app-config', 'data:', '  mode: dev'].join('\n');
const EDITED = ['kind: ConfigMap', 'metadata:', '  name: app-config', 'data:', '  mode: prod'].join('\n');

const props = {
    open: true,
    onOpenChange: () => {},
    live: LIVE,
    next: EDITED,
    kind: 'ConfigMap',
    name: 'app-config',
    saving: false,
    onSave: () => {},
};

describe('manifest review', () => {
    it('names the object and marks the lines the save carries', () => {
        renderWithQuery(<ManifestReview {...props} />);
        const review = screen.getByTestId('manifest-review');
        expect(review).toHaveTextContent('Save changes to ConfigMap “app-config”?');
        const diff = within(review).getByTestId('manifest-diff');
        expect(within(diff).getByText('mode: dev').closest('tr')).toHaveAttribute('data-diff', 'removed');
        expect(within(diff).getByText('mode: prod').closest('tr')).toHaveAttribute('data-diff', 'added');
        // The lines a replace leaves alone are still shown, since a diff without them says nothing
        // about where the change sits.
        expect(within(diff).getByText('kind: ConfigMap').closest('tr')).toHaveAttribute('data-diff', 'same');
    });

    it('says when the buffer is the object as it stands', () => {
        renderWithQuery(<ManifestReview {...props} next={LIVE} />);
        const review = screen.getByTestId('manifest-review');
        expect(review).toHaveTextContent('No changes: this manifest is the object as it stands.');
        expect(within(review).queryByRole('table')).not.toBeInTheDocument();
    });

    it('saves on demand and holds the dialog open while the write is in flight', async () => {
        const onSave = vi.fn();
        const onOpenChange = vi.fn();
        const { rerender } = renderWithQuery(<ManifestReview {...props} onSave={onSave} onOpenChange={onOpenChange} />);
        await userEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(onSave).toHaveBeenCalledOnce();

        rerender(<ManifestReview {...props} onSave={onSave} onOpenChange={onOpenChange} saving />);
        const saving = screen.getByRole('button', { name: 'Saving…' });
        expect(saving).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDisabled();
    });

    it('scrolls the diff on its own so the buttons stay in view', () => {
        renderWithQuery(<ManifestReview {...props} />);
        const review = screen.getByTestId('manifest-review');
        const scroller = within(review).getByTestId('manifest-diff-scroll');
        expect(within(scroller).getByTestId('manifest-diff')).toBeInTheDocument();
        // The footer is the scrolling region's sibling, so a long manifest never carries Save off
        // the bottom of the dialog.
        expect(within(scroller).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
        expect(within(review).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    it('returns to the editor without writing', async () => {
        const onSave = vi.fn();
        const onOpenChange = vi.fn();
        renderWithQuery(<ManifestReview {...props} onSave={onSave} onOpenChange={onOpenChange} />);
        await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(onSave).not.toHaveBeenCalled();
    });
});
