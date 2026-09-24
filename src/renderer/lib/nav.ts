import {
    ArrowUpNarrowWideIcon,
    BoxIcon,
    BoxesIcon,
    CalendarClockIcon,
    CodeIcon,
    CopyIcon,
    CpuIcon,
    DatabaseIcon,
    LayoutDashboardIcon,
    type LucideIcon,
    FileTextIcon,
    GaugeIcon,
    GlobeIcon,
    HardDriveIcon,
    KeyRoundIcon,
    LayersIcon,
    LockIcon,
    PackageIcon,
    PencilIcon,
    PlayIcon,
    PlugIcon,
    RocketIcon,
    RouteIcon,
    ScaleIcon,
    ServerIcon,
    SettingsIcon,
    ShieldCheckIcon,
    ShieldIcon,
    TimerIcon,
    TrendingUpIcon,
    UserIcon,
    WavesIcon,
    WaypointsIcon,
} from 'lucide-react';
import type { RoutePath } from './router';

export interface NavItem {
    id: string;
    label: string;
    /** Typed against the generated route tree, so a renamed or removed route breaks typecheck. */
    path: RoutePath;
    icon: LucideIcon;
}

export interface NavGroup {
    label: string | null;
    items: NavItem[];
}

export interface Domain {
    id: string;
    label: string;
    icon: LucideIcon;
    basePath: string;
    groups: NavGroup[];
}

/** The sidebar sections, the breadcrumbs and the command palette all derive from this one table. */
export const DOMAINS: Domain[] = [
    {
        id: 'overview',
        label: 'Overview',
        icon: LayoutDashboardIcon,
        basePath: '/overview',
        groups: [
            {
                label: null,
                items: [
                    { id: 'summary', label: 'Cluster summary', path: '/overview/summary', icon: BoxesIcon },
                    { id: 'nodes', label: 'Nodes', path: '/overview/nodes', icon: ServerIcon },
                    { id: 'namespaces', label: 'Namespaces', path: '/overview/namespaces', icon: BoxesIcon },
                    { id: 'events', label: 'Events stream', path: '/overview/events', icon: CalendarClockIcon },
                    { id: 'quotas', label: 'Quotas', path: '/overview/quotas', icon: LayersIcon },
                    { id: 'limits', label: 'Limits', path: '/overview/limits', icon: GaugeIcon },
                    {
                        id: 'priorityclasses',
                        label: 'Priority Classes',
                        path: '/overview/priorityclasses',
                        icon: ArrowUpNarrowWideIcon,
                    },
                    { id: 'leases', label: 'Leases', path: '/overview/leases', icon: KeyRoundIcon },
                    {
                        id: 'runtimeclasses',
                        label: 'Runtime Classes',
                        path: '/overview/runtimeclasses',
                        icon: CpuIcon,
                    },
                ],
            },
        ],
    },
    {
        id: 'workloads',
        label: 'Workloads',
        icon: BoxIcon,
        basePath: '/workloads',
        groups: [
            {
                label: 'COMPUTE',
                items: [
                    { id: 'pods', label: 'Pods', path: '/workloads/pods', icon: BoxIcon },
                    { id: 'deployments', label: 'Deployments', path: '/workloads/deployments', icon: BoxesIcon },
                    { id: 'statefulsets', label: 'Stateful Sets', path: '/workloads/statefulsets', icon: BoxesIcon },
                    { id: 'daemonsets', label: 'Daemon Sets', path: '/workloads/daemonsets', icon: BoxesIcon },
                    { id: 'replicasets', label: 'Replica Sets', path: '/workloads/replicasets', icon: CopyIcon },
                    {
                        id: 'replicationcontrollers',
                        label: 'Replication Controllers',
                        path: '/workloads/replicationcontrollers',
                        icon: CopyIcon,
                    },
                ],
            },
            {
                label: 'BATCH',
                items: [
                    { id: 'jobs', label: 'Jobs', path: '/workloads/jobs', icon: PlayIcon },
                    { id: 'cronjobs', label: 'Cron Jobs', path: '/workloads/cronjobs', icon: TimerIcon },
                ],
            },
            {
                label: 'CONFIG',
                items: [
                    { id: 'configmaps', label: 'Config Maps', path: '/workloads/configmaps', icon: FileTextIcon },
                    { id: 'secrets', label: 'Secrets', path: '/workloads/secrets', icon: LockIcon },
                    { id: 'autoscalers', label: 'Autoscalers', path: '/workloads/autoscalers', icon: TrendingUpIcon },
                    {
                        id: 'disruptionbudgets',
                        label: 'Disruption Budgets',
                        path: '/workloads/disruptionbudgets',
                        icon: ShieldCheckIcon,
                    },
                ],
            },
        ],
    },
    {
        id: 'network',
        label: 'Network',
        icon: GlobeIcon,
        basePath: '/network',
        groups: [
            {
                label: 'TRAFFIC',
                items: [
                    { id: 'services', label: 'Services', path: '/network/services', icon: GlobeIcon },
                    { id: 'ingresses', label: 'Ingresses', path: '/network/ingresses', icon: RouteIcon },
                    { id: 'endpoints', label: 'Endpoints', path: '/network/endpoints', icon: WaypointsIcon },
                    {
                        id: 'ingressclasses',
                        label: 'Ingress Classes',
                        path: '/network/ingressclasses',
                        icon: LayersIcon,
                    },
                ],
            },
            {
                label: 'POLICY',
                items: [
                    {
                        id: 'networkpolicies',
                        label: 'Network Policies',
                        path: '/network/networkpolicies',
                        icon: ShieldIcon,
                    },
                ],
            },
        ],
    },
    {
        id: 'storage',
        label: 'Storage',
        icon: DatabaseIcon,
        basePath: '/storage',
        groups: [
            {
                label: null,
                items: [
                    { id: 'volumes', label: 'Volumes', path: '/storage/volumes', icon: DatabaseIcon },
                    { id: 'claims', label: 'Claims', path: '/storage/claims', icon: HardDriveIcon },
                    {
                        id: 'storageclasses',
                        label: 'Storage Classes',
                        path: '/storage/storageclasses',
                        icon: LayersIcon,
                    },
                    { id: 'snapshots', label: 'Snapshots', path: '/storage/snapshots', icon: CopyIcon },
                ],
            },
            {
                label: 'CSI',
                items: [
                    { id: 'csidrivers', label: 'CSI Drivers', path: '/storage/csidrivers', icon: PlugIcon },
                    { id: 'csinodes', label: 'CSI Nodes', path: '/storage/csinodes', icon: ServerIcon },
                    { id: 'capacity', label: 'Storage Capacity', path: '/storage/capacity', icon: GaugeIcon },
                ],
            },
        ],
    },
    {
        id: 'access',
        label: 'Access',
        icon: ShieldIcon,
        basePath: '/access',
        groups: [
            {
                label: 'IDENTITY',
                items: [
                    {
                        id: 'serviceaccounts',
                        label: 'Service Accounts',
                        path: '/access/serviceaccounts',
                        icon: UserIcon,
                    },
                ],
            },
            {
                label: 'ROLES',
                items: [
                    { id: 'roles', label: 'Roles', path: '/access/roles', icon: ShieldIcon },
                    {
                        id: 'rolebindings',
                        label: 'Role Bindings',
                        path: '/access/rolebindings',
                        icon: ShieldCheckIcon,
                    },
                    { id: 'clusterroles', label: 'Cluster Roles', path: '/access/clusterroles', icon: ShieldIcon },
                    {
                        id: 'clusterrolebindings',
                        label: 'Cluster Role Bindings',
                        path: '/access/clusterrolebindings',
                        icon: ShieldCheckIcon,
                    },
                ],
            },
        ],
    },
    {
        id: 'addons',
        label: 'Add-ons',
        icon: BoxesIcon,
        basePath: '/addons',
        groups: [
            {
                label: null,
                items: [
                    { id: 'charts', label: 'Helm charts', path: '/addons/charts', icon: PackageIcon },
                    { id: 'releases', label: 'Releases', path: '/addons/releases', icon: RocketIcon },
                    { id: 'crds', label: 'CRDs', path: '/addons/crds', icon: CodeIcon },
                ],
            },
            {
                label: 'ADMISSION',
                items: [
                    {
                        id: 'mutatingwebhooks',
                        label: 'Mutating Webhooks',
                        path: '/addons/mutatingwebhooks',
                        icon: PencilIcon,
                    },
                    {
                        id: 'validatingwebhooks',
                        label: 'Validating Webhooks',
                        path: '/addons/validatingwebhooks',
                        icon: ShieldIcon,
                    },
                    {
                        id: 'admissionpolicies',
                        label: 'Admission Policies',
                        path: '/addons/admissionpolicies',
                        icon: ScaleIcon,
                    },
                ],
            },
            {
                label: 'API SERVER',
                items: [
                    { id: 'apiservices', label: 'API Services', path: '/addons/apiservices', icon: PlugIcon },
                    { id: 'flowschemas', label: 'Flow Schemas', path: '/addons/flowschemas', icon: WavesIcon },
                ],
            },
        ],
    },
];

export const SETTINGS_NAV: NavItem = { id: 'settings', label: 'Settings', path: '/settings', icon: SettingsIcon };

const SETTINGS_DOMAIN: Domain = {
    id: 'settings',
    label: 'Settings',
    icon: SettingsIcon,
    basePath: '/settings',
    groups: [{ label: null, items: [SETTINGS_NAV] }],
};

/** Every domain including Settings, which the sidebar renders in its footer rather than as a section. */
export const ALL_DOMAINS: Domain[] = [...DOMAINS, SETTINGS_DOMAIN];

export const CLUSTER_LANDING: RoutePath = '/overview/summary';

/** `pathname` is `path` or a sub-page beneath it, matched on a `/` boundary. */
export function isActivePath(pathname: string, path: string): boolean {
    return pathname === path || pathname.startsWith(path + '/');
}

export function domainForPath(pathname: string): Domain | undefined {
    return ALL_DOMAINS.find((domain) => isActivePath(pathname, domain.basePath));
}

/** Id of the domain owning the item that matches the pathname. */
export function activeSectionId(pathname: string): string | undefined {
    return navItemForPath(pathname)?.domain.id;
}

export function navItemForPath(pathname: string): { domain: Domain; item: NavItem } | undefined {
    for (const domain of ALL_DOMAINS) {
        for (const group of domain.groups) {
            for (const item of group.items) {
                if (isActivePath(pathname, item.path)) return { domain, item };
            }
        }
    }
    return undefined;
}

/** Instances of a definition are listed under its name; no nav item names them, since the app cannot know the kinds. */
const INSTANCES_PREFIX = '/addons/instances/';

/**
 * For a sub-page beneath a list item (a detail), the list path; otherwise undefined. A custom-resource
 * instance's list is the one for its definition, `/addons/instances/<crd>`.
 */
export function listPathForSubPage(pathname: string): string | undefined {
    if (pathname.startsWith(INSTANCES_PREFIX)) {
        const [crd, ...rest] = pathname.slice(INSTANCES_PREFIX.length).split('/');
        return crd && rest.length > 0 ? INSTANCES_PREFIX + crd : undefined;
    }
    const match = navItemForPath(pathname);
    return match && pathname !== match.item.path ? match.item.path : undefined;
}

export interface Crumb {
    label: string;
    icon?: LucideIcon;
    to?: string;
}

/**
 * Breadcrumbs: the owning nav item, then one crumb per remaining path segment, decoded. A detail
 * screen whose path ends in a tab id passes that tab's label, which names the last crumb instead of
 * the id.
 */
export function breadcrumbsForPath(pathname: string, tabLabel?: string): Crumb[] {
    const match = navItemForPath(pathname);
    if (!match) return [];
    const crumbs: Crumb[] = [{ label: match.item.label, icon: match.item.icon, to: match.item.path }];
    if (pathname.startsWith(match.item.path + '/')) {
        for (const segment of pathname.slice(match.item.path.length + 1).split('/')) {
            if (segment) crumbs.push({ label: decodeURIComponent(segment) });
        }
    }
    const last = crumbs.at(-1);
    if (tabLabel && crumbs.length > 1 && last) last.label = tabLabel;
    return crumbs;
}
