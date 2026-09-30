import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartUpgradeReview } from '../../../src/shared/chart-upgrade';
import { renderRoutes } from './helpers';

const invoke = vi.fn();
const subscribe = vi.fn(() => () => {});
const stream = vi.fn(() => ({ stop: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/ipc', async () => ({
    ...(await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc')),
    invoke,
    subscribe,
    stream,
}));

const toasts = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', async () => ({
    ...(await vi.importActual<typeof import('sonner')>('sonner')),
    toast: toasts,
}));

const { routeTree } = await import('@/routeTree.gen');
const { defaultSource } = await import('@/components/release/upgrade-release');

const PATH = '/helm/releases/team-a/web/upgrade';

const review: ChartUpgradeReview = {
    reviewId: 'up-1',
    name: 'web',
    namespace: 'team-a',
    source: 'fixture',
    chart: 'km-demo',
    version: '0.2.0',
    revision: 3,
    from: { revision: 2, chart: 'km-demo-0.1.0' },
    previousValues: 'greeting: hello\n',
    values: 'greeting: hi\n',
    objects: [
        {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            name: 'web-settings',
            namespace: 'team-a',
            source: 'km-demo/templates/configmap.yaml',
            manifest: 'kind: ConfigMap\n',
            check: { state: 'passed' },
            change: 'update',
            live: 'data:\n  greeting: hello\n',
            next: 'data:\n  greeting: hi\n',
        },
        {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            name: 'web',
            namespace: 'team-a',
            source: 'km-demo/templates/deployment.yaml',
            manifest: 'kind: Deployment\n',
            check: { state: 'passed' },
            change: 'unchanged',
            live: 'spec: {}\n',
            next: 'spec: {}\n',
        },
    ],
    removed: [
        {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            name: 'web-old',
            namespace: 'team-a',
            kept: false,
            live: 'kind: ConfigMap\n',
        },
        { apiVersion: 'v1', kind: 'Secret', name: 'web-keep', namespace: 'team-a', kept: true, live: 'kind: Secret\n' },
    ],
    hooks: [
        {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: 'web-migrate',
            namespace: 'team-a',
            source: 'km-demo/templates/hook.yaml',
            manifest: 'kind: Job\n',
            check: { state: 'passed' },
            events: ['pre-upgrade'],
            weight: 0,
            deletePolicies: [],
        },
    ],
    skippedCrds: 1,
    usesLookup: false,
};

let data: Record<string, unknown>;

beforeEach(() => {
    toasts.success.mockReset();
    toasts.error.mockReset();
    data = {
        'update.state': { status: 'up-to-date' },
        'contexts.list': [{ name: 'alpha', cluster: 'a', user: 'u', current: true }],
        'context.current': { name: 'alpha', cluster: 'a', user: 'u', current: true },
        'namespaces.list': [{ name: 'team-a', tone: 'accent' }],
        'namespace.active': { name: 'team-a' },
        'cluster.active': null,
        'helm.status': { found: true, path: '/usr/local/bin/helm', version: '3.15.1' },
        'chartRepositories.list': [
            {
                name: 'other',
                kind: 'classic',
                url: 'https://other.test',
                hasCredentials: false,
                chartCount: 1,
                refreshedAt: null,
            },
            {
                name: 'fixture',
                kind: 'classic',
                url: 'https://fixture.test',
                hasCredentials: false,
                chartCount: 1,
                refreshedAt: null,
            },
        ],
        'charts.values': { valuesYaml: 'greeting: hello\n', schema: null, schemaProblem: null, subcharts: [] },
        'charts.renderUpgrade': { rendered: true, review },
        'releases.upgrade': { name: 'web', namespace: 'team-a', revision: 3, status: 'deployed', message: null },
        'releases.get': {
            name: 'web',
            namespace: 'team-a',
            chart: 'km-demo-0.1.0',
            chartName: 'km-demo',
            chartVersion: '0.1.0',
            revision: 2,
            status: 'Deployed',
            updated: '1m',
            values: 'greeting: hello\n',
        },
        'releases.revisions': [],
        'releases.resources': [],
    };
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string, input: { source?: string }) => {
        if (channel === 'charts.versions') {
            // Only the second source publishes this chart, so it is the one an upgrade starts from.
            if (input.source === 'other') throw Object.assign(new Error('other has no chart named "km-demo".'), {});
            return ['0.2.0', '0.1.0'];
        }
        return data[channel];
    });
});

const reviewButton = () => screen.findByRole('button', { name: 'Review' });

async function openReview() {
    renderRoutes(routeTree, PATH);
    await waitFor(async () => expect(await reviewButton()).toBeEnabled());
    await userEvent.click(await reviewButton());
    return screen.findByTestId('upgrade-review');
}

describe('defaultSource', () => {
    it('is the first classic repository listing the chart, else the first registry, else the first source', () => {
        const repositories = [
            { name: 'a', kind: 'classic' as const },
            { name: 'b', kind: 'classic' as const },
            { name: 'r', kind: 'oci' as const },
        ];
        expect(
            defaultSource(repositories, [
                { source: 'a', versions: undefined, settled: true },
                { source: 'b', versions: ['1.0.0'], settled: true },
            ]),
        ).toBe('b');
        expect(defaultSource(repositories, [{ source: 'a', versions: undefined, settled: false }])).toBeUndefined();
        expect(defaultSource(repositories, [{ source: 'a', versions: [], settled: true }])).toBe('r');
        expect(
            defaultSource([{ name: 'a', kind: 'classic' }], [{ source: 'a', versions: undefined, settled: true }]),
        ).toBe('a');
    });
});

describe('upgrading a release', () => {
    it('starts from the current revision’s values and the newest version of the source listing the chart', async () => {
        await openReview();
        expect(invoke).toHaveBeenCalledWith('charts.values', { source: 'fixture', chart: 'km-demo', version: '0.2.0' });
        expect(invoke).toHaveBeenCalledWith('charts.renderUpgrade', {
            source: 'fixture',
            chart: 'km-demo',
            version: '0.2.0',
            name: 'web',
            namespace: 'team-a',
            values: { greeting: 'hello' },
            context: 'alpha',
        });
    });

    it('shows the values diff, each object’s change, what is removed and kept, before anything is written', async () => {
        const page = await openReview();
        const values = within(page).getByTestId('upgrade-review-values');
        expect(values.querySelector('[data-diff="removed"]')).toHaveTextContent('greeting: hello');
        expect(values.querySelector('[data-diff="added"]')).toHaveTextContent('greeting: hi');

        const settings = page.querySelector('[data-object="ConfigMap/web-settings"]') as HTMLElement;
        expect(settings).toHaveTextContent('Changed');
        await userEvent.click(within(settings).getByRole('button'));
        expect(settings.querySelector('[data-diff="added"]')).toHaveTextContent('greeting: hi');
        expect(page.querySelector('[data-object="Deployment/web"]')).toHaveTextContent('Unchanged');

        const removed = within(page).getByTestId('upgrade-review-removed');
        expect(removed.querySelector('[data-object="ConfigMap/web-old"]')).toHaveTextContent('Deleted');
        expect(removed.querySelector('[data-object="Secret/web-keep"]')).toHaveTextContent('Kept');
        expect(within(page).getByTestId('upgrade-review-crds')).toHaveTextContent('1 custom resource definition');
        expect(invoke).not.toHaveBeenCalledWith('releases.upgrade', expect.anything());
    });

    it('upgrades that review and opens the release', async () => {
        await openReview();
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to revision 3' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('releases.upgrade', { reviewId: 'up-1', context: 'alpha' }),
        );
        await screen.findByTestId('release-page');
        expect(toasts.success).toHaveBeenCalledWith('Release “web” upgraded', expect.anything());
    });

    it('refuses to upgrade a review its dry run refused', async () => {
        data['charts.renderUpgrade'] = {
            rendered: true,
            review: {
                ...review,
                objects: [{ ...review.objects[0]!, check: { state: 'failed', message: 'not owned by release "web"' } }],
            },
        };
        const page = await openReview();
        expect(within(page).getByTestId('upgrade-review-problem')).toHaveTextContent('not owned by release "web"');
        expect(screen.getByRole('button', { name: 'Upgrade to revision 3' })).toBeDisabled();
    });

    it('says a failed upgrade was recorded and leaves the previous revision deployed', async () => {
        data['releases.upgrade'] = {
            name: 'web',
            namespace: 'team-a',
            revision: 3,
            status: 'failed',
            message: 'The hook Job "web-migrate" failed.',
        };
        await openReview();
        await userEvent.click(screen.getByRole('button', { name: 'Upgrade to revision 3' }));
        const failed = await screen.findByTestId('upgrade-failed');
        expect(failed).toHaveTextContent('The hook Job "web-migrate" failed.');
        expect(failed).toHaveTextContent('Revision 3 is recorded as failed');
    });

    it('lays a render Helm refused over the values and stays on them', async () => {
        data['charts.renderUpgrade'] = { rendered: false, reason: 'template', message: 'a greeting is required' };
        renderRoutes(routeTree, PATH);
        await waitFor(async () => expect(await reviewButton()).toBeEnabled());
        await userEvent.click(await reviewButton());
        expect(await screen.findByTestId('values-render-error')).toHaveTextContent('a greeting is required');
        expect(screen.queryByTestId('upgrade-review')).toBeNull();
    });

    it('says Helm is required, and that a repository is, rather than offering an upgrade', async () => {
        data['helm.status'] = { found: false };
        const { unmount } = renderRoutes(routeTree, PATH);
        expect(await screen.findByTestId('upgrade-no-helm')).toHaveTextContent('helm template');
        unmount();

        data['helm.status'] = { found: true, path: '/usr/local/bin/helm', version: '3.15.1' };
        data['chartRepositories.list'] = [];
        renderRoutes(routeTree, PATH);
        const none = await screen.findByTestId('upgrade-no-sources');
        expect(none).toHaveTextContent('Settings › Charts');
        expect(within(none).getByRole('link', { name: 'Settings › Charts' })).toHaveAttribute(
            'href',
            '/settings/charts',
        );
    });

    it('is offered from the release’s own header', async () => {
        renderRoutes(routeTree, '/helm/releases/team-a/web');
        const upgrade = await screen.findByRole('link', { name: 'Upgrade' });
        expect(upgrade).toHaveAttribute('href', expect.stringContaining('/helm/releases/team-a/web/upgrade'));
    });
});
