import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { UnavailableButton } from '@/components/unavailable-button';
import { renderWithQuery } from './helpers';

describe('UnavailableButton', () => {
    it('stays focusable, blocks activation, and explains itself on focus', async () => {
        const onClick = vi.fn((event: React.MouseEvent) => event.defaultPrevented);
        renderWithQuery(
            <form onSubmit={onClick}>
                <UnavailableButton reason="This pod has no workload to roll">Restart</UnavailableButton>
            </form>,
        );
        const button = screen.getByRole('button', { name: 'Restart' });
        expect(button).toHaveAttribute('aria-disabled', 'true');
        expect(button).not.toBeDisabled();
        expect(button).toHaveClass('opacity-50');
        await userEvent.click(button);
        expect(onClick).not.toHaveBeenCalled();
        // The reason is announced on focus, which is why the button is aria-disabled instead of disabled.
        // The click above left focus on the button, so step away and tab back in.
        button.blur();
        await userEvent.tab();
        expect(button).toHaveFocus();
        expect(await screen.findByRole('tooltip', {}, { timeout: 3000 })).toHaveTextContent(
            'This pod has no workload to roll',
        );
    });
});
