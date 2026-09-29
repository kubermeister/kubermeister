import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartReview } from '../../../src/shared/chart-install';
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

const PATH = '/helm/charts/install/fixture/km-demo/0.1.0';

const review: ChartReview = {
    reviewId: 'review-1',
    name: 'km-demo',
    namespace: 'team-a',
    source: 'fixture',
    chart: 'km-demo',
    version: '0.1.0',
    crds: [],
    objects: [
        {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            name: 'km-demo',
            namespace: 'team-a',
            source: 'km-demo/templates/configmap.yaml',
            manifest: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: km-demo\n',
            check: { state: 'passed' },
        },
    ],
    hooks: [
        {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: 'km-demo-prepare',
            namespace: 'team-a',
            source: 'km-demo/templates/hook.yaml',
            manifest: 'kind: Job\n',
            check: { state: 'passed' },
            events: ['pre-install'],
            weight: 0,
            deletePolicies: ['hook-succeeded'],
        },
    ],
    usesLookup: true,
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
        'charts.versions': ['0.2.0', '0.1.0'],
        'charts.values': {
            // `yes` is YAML 1.1's true and YAML 1.2's string; the editor reads 1.2, and so must Helm.
            valuesYaml: 'greeting: hello\nenabled: yes\n',
            schema: null,
            schemaProblem: null,
            subcharts: [],
        },
        'charts.render': { rendered: true, review },
        'releases.install': { name: 'km-demo', namespace: 'team-a', revision: 1, status: 'deployed', message: null },
        'releases.get': null,
        'releases.revisions': [],
        'releases.resources': [],
    };
    invoke.mockReset();
    invoke.mockImplementation(async (channel: string) => data[channel]);
});

const reviewButton = () => screen.findByRole('button', { name: 'Review' });

async function openReview() {
    renderRoutes(routeTree, PATH);
    await waitFor(async () => expect(await reviewButton()).toBeEnabled());
    await userEvent.click(await reviewButton());
    return screen.findByTestId('install-review');
}

describe('installing a chart', () => {
    it('renders the values as the editor reads them, for the active namespace and context', async () => {
        await openReview();
        expect(invoke).toHaveBeenCalledWith('charts.values', { source: 'fixture', chart: 'km-demo', version: '0.1.0' });
        expect(invoke).toHaveBeenCalledWith('charts.render', {
            source: 'fixture',
            chart: 'km-demo',
            version: '0.1.0',
            name: 'km-demo',
            namespace: 'team-a',
            values: { greeting: 'hello', enabled: 'yes' },
            context: 'alpha',
        });
    });

    it('reviews every object with its dry run, flags lookup, and installs that review', async () => {
        const page = await openReview();
        expect(within(page).getByTestId('install-review-lookup')).toHaveTextContent('lookup');
        const hook = page.querySelector('[data-object="Job/km-demo-prepare"]') as HTMLElement;
        expect(hook).toHaveTextContent('pre-install · weight 0');
        expect(hook).toHaveTextContent('Checked');
        const object = page.querySelector('[data-object="ConfigMap/km-demo"]') as HTMLElement;
        await userEvent.click(within(object).getByRole('button'));
        expect(object).toHaveTextContent('km-demo/templates/configmap.yaml');

        await userEvent.click(screen.getByRole('button', { name: 'Install km-demo' }));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('releases.install', { reviewId: 'review-1', context: 'alpha' }),
        );
        await screen.findByTestId('release-page');
        expect(toasts.success).toHaveBeenCalledWith('Release “km-demo” installed', expect.anything());
    });

    it('lays a render Helm refused over the values and stays on them', async () => {
        data['charts.render'] = {
            rendered: false,
            reason: 'template',
            message: 'execution error at (km-demo/templates/configmap.yaml:4:3): a greeting is required',
        };
        renderRoutes(routeTree, PATH);
        await waitFor(async () => expect(await reviewButton()).toBeEnabled());
        await userEvent.click(await reviewButton());
        expect(await screen.findByTestId('values-render-error')).toHaveTextContent('a greeting is required');
        expect(screen.queryByTestId('install-review')).toBeNull();
    });

    it('will not install a review whose dry run refused an object', async () => {
        data['charts.render'] = {
            rendered: true,
            review: {
                ...review,
                objects: [
                    {
                        ...review.objects[0]!,
                        check: { state: 'failed', message: 'configmaps "km-demo" already exists' },
                    },
                ],
            },
        };
        await openReview();
        expect(screen.getByTestId('install-review-problem')).toHaveTextContent('already exists');
        expect(screen.getByRole('button', { name: 'Install km-demo' })).toBeDisabled();
    });

    it('offers to uninstall a release that failed part-way', async () => {
        data['releases.install'] = {
            name: 'km-demo',
            namespace: 'team-a',
            revision: 1,
            status: 'failed',
            message: 'The hook Job "km-demo-prepare" in team-a failed: job failed: BackoffLimitExceeded.',
        };
        await openReview();
        await userEvent.click(screen.getByRole('button', { name: 'Install km-demo' }));
        const failed = await screen.findByTestId('install-failed');
        expect(failed).toHaveTextContent('BackoffLimitExceeded');
        expect(within(failed).getByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
        expect(within(failed).getByRole('link', { name: 'Open release' })).toHaveAttribute(
            'href',
            '/helm/releases/team-a/km-demo',
        );
    });

    it('goes back to the values when the install is refused before it writes anything', async () => {
        invoke.mockImplementation(async (channel: string) => {
            if (channel === 'releases.install') {
                const { IpcError } = await import('@/lib/ipc');
                throw new IpcError({ kind: 'invalid', detail: 'This review has expired.', op: 'releases.install' });
            }
            return data[channel];
        });
        await openReview();
        await userEvent.click(screen.getByRole('button', { name: 'Install km-demo' }));
        await waitFor(() => expect(screen.queryByTestId('install-review')).toBeNull());
        expect(await reviewButton()).toBeInTheDocument();
    });

    it('says Helm is required, and offers nothing else, when none is installed', async () => {
        data['helm.status'] = { found: false };
        renderRoutes(routeTree, PATH);
        expect(await screen.findByTestId('install-no-helm')).toHaveTextContent('Helm is required to install a chart');
        expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    });

    it('refuses to review under All namespaces or with a name Helm would refuse', async () => {
        data['namespace.active'] = { name: null };
        renderRoutes(routeTree, PATH);
        expect(await screen.findByTestId('install-all-namespaces')).toBeInTheDocument();
        expect(await reviewButton()).toBeDisabled();
    });

    it('checks the release name as it is typed', async () => {
        renderRoutes(routeTree, PATH);
        const name = await screen.findByRole('textbox', { name: 'Release name' });
        await userEvent.clear(name);
        await userEvent.type(name, 'Demo_1');
        expect(screen.getByTestId('install-name-problem')).toHaveTextContent('Lowercase letters');
        expect(await reviewButton()).toBeDisabled();
    });

    it('switches the version in place, reading that version’s values', async () => {
        const { router } = renderRoutes(routeTree, PATH);
        await userEvent.click(await screen.findByRole('combobox', { name: 'Chart version' }));
        await userEvent.click(await screen.findByRole('option', { name: '0.2.0' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/helm/charts/install/fixture/km-demo/0.2.0'));
        await waitFor(() =>
            expect(invoke).toHaveBeenCalledWith('charts.values', {
                source: 'fixture',
                chart: 'km-demo',
                version: '0.2.0',
            }),
        );
    });
});
