import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MiddleTruncate } from '@/components/data-display/middle-truncate';

describe('MiddleTruncate', () => {
    it('keeps the end of a long name whole and lets the start take the ellipsis', () => {
        const name = 'organization-directory-service-public-projects-join-consumer';
        const { container } = render(<MiddleTruncate text={name} />);
        const outer = container.firstElementChild!;
        expect(outer).toHaveAttribute('title', name);
        expect(outer.textContent).toBe(name);
        const [start, end] = Array.from(outer.children);
        expect(start).toHaveClass('truncate');
        expect(end!.textContent).toBe(name.slice(-12));
        expect(end).toHaveClass('shrink-0');
    });

    it('leaves a short name as one piece, cut at its end only if it ever has to be', () => {
        const { container } = render(<MiddleTruncate text="team-a" className="text-primary" />);
        const outer = container.firstElementChild!;
        expect(outer.children).toHaveLength(0);
        expect(outer).toHaveClass('truncate', 'text-primary');
        expect(outer).toHaveAttribute('title', 'team-a');
    });
});
