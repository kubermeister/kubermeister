import { render, screen, within } from '@testing-library/react';
import { LayersIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { MetricCard } from '@/components/data-display/metric-card';
import { Sparkline } from '@/components/data-display/sparkline';
import { StatusBadge } from '@/components/data-display/status-badge';
import { StatusDot } from '@/components/data-display/status-dot';
import { KMLogo } from '@/components/km-logo';
import { DetailCard, DetailMetrics, PropertyGrid } from '@/components/templates/detail-cards';
import { DetailHeader } from '@/components/templates/detail-header';

describe('DetailHeader', () => {
    it('renders the eyebrow spaced by kind casing, the title, status, meta and actions', () => {
        render(
            <DetailHeader
                icon={LayersIcon}
                eyebrow="StatefulSet"
                title="web"
                status={{ label: 'Running', tone: 'ok' }}
                meta={['team-a', '3d']}
                actions={<button>Act</button>}
            />,
        );
        expect(screen.getByText('Stateful Set')).toBeInTheDocument();
        expect(screen.getByText('web')).toBeInTheDocument();
        expect(screen.getByText('Running')).toHaveAttribute('data-tone', 'ok');
        expect(screen.getByText('team-a')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Act' })).toBeInTheDocument();
        expect(document.querySelector('svg.lucide-layers')).not.toBeNull();
    });

    it('renders the bare title when everything optional is omitted', () => {
        render(<DetailHeader title="lonely" meta={[]} />);
        expect(screen.getByText('lonely')).toBeInTheDocument();
        expect(document.querySelector('svg')).toBeNull();
    });
});

describe('DetailCard and PropertyGrid', () => {
    it('renders header, description, action and body', () => {
        render(
            <DetailCard title="Placement" desc="Where it runs" action={<button>Edit</button>}>
                <PropertyGrid
                    columns={1}
                    rows={[
                        ['Node', 'n1'],
                        ['QoS', 'Burstable'],
                    ]}
                />
            </DetailCard>,
        );
        expect(screen.getByText('Placement')).toBeInTheDocument();
        expect(screen.getByText('Where it runs')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
        expect(screen.getByText('n1')).toBeInTheDocument();
        expect(screen.getByText('Node').parentElement?.parentElement).toHaveStyle({
            gridTemplateColumns: 'repeat(1, minmax(0, 1fr))',
        });
    });

    it('defaults the grid to two columns', () => {
        render(<PropertyGrid rows={[['a', 'b']]} />);
        expect(screen.getByText('a').parentElement?.parentElement).toHaveStyle({
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        });
    });
});

describe('DetailMetrics and MetricCard', () => {
    it('renders nothing for an empty list and a card per metric otherwise', () => {
        const { container, rerender } = render(<DetailMetrics metrics={[]} />);
        expect(container).toBeEmptyDOMElement();
        rerender(
            <DetailMetrics
                metrics={[
                    { label: 'Nodes', value: '3', sub: 'all ready' },
                    { label: 'Pods', value: '42', spark: [1, 2, 3] },
                ]}
            />,
        );
        expect(screen.getByText('Nodes')).toBeInTheDocument();
        expect(screen.getByText('all ready')).toBeInTheDocument();
        expect(screen.getByText('42').closest('[data-slot="card"]')?.querySelector('svg')).not.toBeNull();
    });

    it('renders a metric card without sparkline or sub line', () => {
        const { container } = render(<MetricCard label="CPU" value="12%" />);
        expect(screen.getByText('12%')).toBeInTheDocument();
        expect(container.querySelector('svg')).toBeNull();
    });
});

describe('Sparkline', () => {
    it('needs at least two points and draws a line plus an optional area', () => {
        const { container, rerender } = render(<Sparkline data={[1]} />);
        expect(container.querySelector('svg')).toBeNull();
        rerender(<Sparkline data={[0, 5, 10]} width={100} height={20} />);
        const paths = container.querySelectorAll('path');
        expect(paths).toHaveLength(1);
        expect(paths[0]?.getAttribute('d')).toMatch(/^M0,19 L50,10 L100,1$/);
        rerender(<Sparkline data={[3, 3]} fill />);
        expect(container.querySelectorAll('path')).toHaveLength(2);
    });
});

describe('status primitives and logo', () => {
    it('gives the dot a tone class and title, and the badge a dot plus data-tone', () => {
        render(<StatusDot tone="danger" title="bad" />);
        expect(screen.getByTitle('bad')).toHaveClass('bg-danger');
        render(<StatusBadge tone="warn">Pending</StatusBadge>);
        const badge = screen.getByText('Pending');
        expect(badge).toHaveAttribute('data-tone', 'warn');
        expect(within(badge).getByText('', { selector: 'span.bg-warn' })).toBeInTheDocument();
    });

    it('names a dot with a title for a screen reader and hides one that only repeats its label', () => {
        render(<StatusDot tone="danger" title="Cluster unreachable" />);
        expect(screen.getByRole('img', { name: 'Cluster unreachable' })).toHaveClass('bg-danger');
        render(<StatusBadge tone="ok">Running</StatusBadge>);
        const dot = within(screen.getByText('Running')).getByText('', { selector: 'span.bg-ok' });
        expect(dot).toHaveAttribute('aria-hidden', 'true');
        expect(dot).not.toHaveAttribute('role');
    });

    it('renders the wordmark by default and names the app through the svg without it', () => {
        const { rerender } = render(<KMLogo />);
        expect(screen.getByText('Kubermeister')).toBeInTheDocument();
        expect(document.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
        rerender(<KMLogo wordmark={false} />);
        expect(screen.queryByText('Kubermeister')).not.toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Kubermeister' })).toBeInTheDocument();
    });
});
