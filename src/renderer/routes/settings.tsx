import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ExternalLinkIcon, MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import {
    DEFAULT_UPDATE_MODE,
    LOG_BUFFER_OPTIONS,
    PROXY_MODES,
    READ_TIMEOUT_OPTIONS,
    REFRESH_INTERVAL_OPTIONS,
    TERMINAL_FONT_SIZES,
    UPDATE_CHECK_INTERVAL_OPTIONS,
    UPDATE_MODES,
    isProxyUrl,
    type ProxyMode,
    type UpdateMode,
} from '../../shared/settings';
import { bugReportUrl } from '../../shared/bug-report';
import { releasePageUrl } from '../../shared/updates';
import { SettingsPage } from '@/components/templates/settings-page';
import { Field, FormCard, FormInput, FormSelect, Toggle } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import { useTheme, type Theme } from '@/components/theme-provider';
import { useIpcQuery } from '@/lib/query';
import {
    clearCaBundle,
    pickCaBundle,
    pickKubeconfig,
    resetKubeconfig,
    updateSettings,
    useSettings,
} from '@/lib/settings';
import { describeUpdate, downloadUpdate, installUpdate, useUpdater } from '@/lib/updates';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/settings')({ component: SettingsScreen });

const THEME_OPTIONS: { value: Theme; label: string; icon: LucideIcon; desc: string }[] = [
    { value: 'light', label: 'Light', icon: SunIcon, desc: 'Cobalt, bright surfaces' },
    { value: 'dark', label: 'Dark', icon: MoonIcon, desc: 'Cobalt, dense night mode' },
    { value: 'system', label: 'System', icon: MonitorIcon, desc: 'Match OS preference' },
];

/** Thousands read better than five digits in a select; the label maps back to its own number. */
const bufferLabel = (lines: number): string => `${(lines / 1000).toLocaleString()}k lines`;
const BUFFER_BY_LABEL = new Map(LOG_BUFFER_OPTIONS.map((lines) => [bufferLabel(lines), lines]));

const intervalLabel = (sec: number) => `${sec} seconds`;

const UPDATE_MODE_LABELS: Record<UpdateMode, string> = {
    check: 'Notify me and let me choose',
    download: 'Download in the background',
    off: 'Never check automatically',
};
const modeForLabel = (label: string): UpdateMode =>
    UPDATE_MODES.find((mode) => UPDATE_MODE_LABELS[mode] === label) ?? DEFAULT_UPDATE_MODE;

const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
    env: 'Follow the environment',
    manual: 'Use this proxy',
    off: 'Connect directly',
};
const proxyModeForLabel = (label: string): ProxyMode =>
    PROXY_MODES.find((mode) => PROXY_MODE_LABELS[mode] === label) ?? 'env';

const checkIntervalLabel = (hours: number) =>
    hours === 1
        ? 'Every hour'
        : hours === 24
          ? 'Once a day'
          : hours % 24 === 0
            ? `Every ${hours / 24} days`
            : `Every ${hours} hours`;

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-3.5">
            <h2 className="text-label font-semibold tracking-[0.12em] text-text-dim uppercase">{title}</h2>
            {children}
        </section>
    );
}

function SettingsScreen() {
    const { theme, setTheme } = useTheme();
    const client = useQueryClient();
    const { data: settings } = useSettings();
    const [connectionBusy, setConnectionBusy] = useState(false);

    const kubeconfigPath = settings?.connection.kubeconfigPath ?? null;
    const proxyMode = settings?.network.proxyMode ?? 'env';
    const proxyUrl = settings?.network.proxyUrl ?? '';
    const noProxy = settings?.network.noProxy ?? '';
    const caBundlePath = settings?.network.caBundlePath ?? null;
    const updateMode = settings?.updates.mode ?? DEFAULT_UPDATE_MODE;
    const checkIntervalHours = settings?.updates.checkIntervalHours ?? 4;
    const refreshSec = settings?.data.refreshIntervalSec ?? 12;
    const readTimeoutSec = settings?.data.readTimeoutSec ?? 60;
    const logBuffer = settings?.data.logBufferLines ?? 2_000;
    const terminalFont = settings?.data.terminalFontSize ?? 12;
    // Fold the current value in so a non-preset interval (the 12 s default) still renders as selected.
    const intervalOptions = Array.from(new Set<number>([...REFRESH_INTERVAL_OPTIONS, refreshSec]))
        .sort((a, b) => a - b)
        .map(intervalLabel);
    const timeoutOptions = Array.from(new Set<number>([...READ_TIMEOUT_OPTIONS, readTimeoutSec]))
        .sort((a, b) => a - b)
        .map(intervalLabel);
    const checkIntervals = Array.from(new Set<number>([...UPDATE_CHECK_INTERVAL_OPTIONS, checkIntervalHours])).sort(
        (a, b) => a - b,
    );
    const checkIntervalByLabel = new Map(checkIntervals.map((hours) => [checkIntervalLabel(hours), hours]));

    const runConnection = async (action: () => Promise<void>) => {
        setConnectionBusy(true);
        try {
            await action();
        } finally {
            setConnectionBusy(false);
        }
    };

    return (
        <SettingsPage title="Settings" desc="Preferences for this Kubermeister install.">
            <Section title="General">
                <FormCard
                    title="Restore last session on launch"
                    desc="Reopen on the context and namespace you last used."
                    action={
                        <Toggle
                            label="Restore last session on launch"
                            checked={settings?.session.restoreOnLaunch ?? true}
                            onCheckedChange={(restoreOnLaunch) =>
                                void updateSettings(client, { session: { restoreOnLaunch } })
                            }
                        />
                    }
                >
                    <p className="text-cell text-text-muted">
                        When off, Kubermeister follows your kubeconfig&apos;s current-context instead.
                    </p>
                </FormCard>

                <FormCard title="Live data refresh" desc="How often lists, metrics and the dashboard poll for updates.">
                    <Field label="Refresh interval">
                        <FormSelect
                            value={intervalLabel(refreshSec)}
                            options={intervalOptions}
                            onValueChange={(label) =>
                                void updateSettings(client, { data: { refreshIntervalSec: parseInt(label, 10) } })
                            }
                        />
                    </Field>
                </FormCard>

                <FormCard
                    title="Cluster reads"
                    desc="How long one request to the API server may take before it is reported as timed out. Large clusters need longer."
                >
                    <Field label="Read timeout">
                        <FormSelect
                            value={intervalLabel(readTimeoutSec)}
                            options={timeoutOptions}
                            onValueChange={(label) =>
                                void updateSettings(client, { data: { readTimeoutSec: parseInt(label, 10) } })
                            }
                        />
                    </Field>
                </FormCard>

                <FormCard title="Terminal" desc="Font size of the shell terminal on a pod.">
                    <Field label="Font size">
                        <FormSelect
                            value={`${terminalFont} pt`}
                            options={TERMINAL_FONT_SIZES.map((size) => `${size} pt`)}
                            onValueChange={(label) =>
                                void updateSettings(client, { data: { terminalFontSize: parseInt(label, 10) } })
                            }
                        />
                    </Field>
                </FormCard>

                <FormCard title="Log buffer" desc="How many lines a live log follow keeps before dropping the oldest.">
                    <Field label="Buffered lines">
                        <FormSelect
                            value={bufferLabel(logBuffer)}
                            options={LOG_BUFFER_OPTIONS.map(bufferLabel)}
                            onValueChange={(label) => {
                                const lines = BUFFER_BY_LABEL.get(label);
                                if (lines) void updateSettings(client, { data: { logBufferLines: lines } });
                            }}
                        />
                    </Field>
                </FormCard>
            </Section>

            <Section title="Appearance">
                <FormCard title="Theme" desc="Switches the entire workspace between light and dark.">
                    <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="Theme">
                        {THEME_OPTIONS.map((opt) => {
                            const Icon = opt.icon;
                            const selected = theme === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => setTheme(opt.value)}
                                    className={cn(
                                        'flex flex-col items-start gap-2 rounded-md border-[1.5px] p-3.5 text-left transition-colors',
                                        selected
                                            ? 'border-primary bg-accent-bg'
                                            : 'border-border bg-elev-2 hover:border-border-hi',
                                    )}
                                >
                                    <Icon className={cn('size-4', selected ? 'text-primary' : 'text-text-muted')} />
                                    <div className="text-lead font-medium">{opt.label}</div>
                                    <div className="text-label text-text-muted">{opt.desc}</div>
                                </button>
                            );
                        })}
                    </div>
                </FormCard>
            </Section>

            <Section title="Updates">
                <FormCard title="Automatic updates" desc="What happens when a new version of Kubermeister is found.">
                    <Field label="When a new version is found">
                        <FormSelect
                            value={UPDATE_MODE_LABELS[updateMode]}
                            options={UPDATE_MODES.map((mode) => UPDATE_MODE_LABELS[mode])}
                            onValueChange={(label) =>
                                void updateSettings(client, { updates: { mode: modeForLabel(label) } })
                            }
                        />
                    </Field>
                    <Field label="Check for new versions">
                        <FormSelect
                            value={checkIntervalLabel(checkIntervalHours)}
                            options={checkIntervals.map(checkIntervalLabel)}
                            onValueChange={(label) => {
                                const hours = checkIntervalByLabel.get(label);
                                if (hours) void updateSettings(client, { updates: { checkIntervalHours: hours } });
                            }}
                        />
                    </Field>
                </FormCard>
                <AboutCard />
            </Section>

            <Section title="Connection">
                <FormCard title="Kubeconfig">
                    <Field
                        label="Kubeconfig path"
                        hint="Choosing a file goes through a native dialog; the app never accepts a typed path."
                    >
                        <div className="flex flex-col gap-2">
                            <span
                                className="truncate font-mono text-cell text-text-2"
                                title={kubeconfigPath ?? undefined}
                                data-testid="kubeconfig-path"
                            >
                                {kubeconfigPath ?? '$KUBECONFIG or ~/.kube/config (default)'}
                            </span>
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={connectionBusy}
                                    onClick={() => void runConnection(() => pickKubeconfig(client))}
                                >
                                    Browse…
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={connectionBusy || !kubeconfigPath}
                                    onClick={() => void runConnection(() => resetKubeconfig(client))}
                                >
                                    Use default
                                </Button>
                            </div>
                        </div>
                    </Field>
                </FormCard>

                <FormCard
                    title="Proxy"
                    desc="How cluster traffic reaches the API server. A context whose kubeconfig sets its own proxy-url always uses that one."
                >
                    <Field label="Proxy">
                        <FormSelect
                            value={PROXY_MODE_LABELS[proxyMode]}
                            options={PROXY_MODES.map((mode) => PROXY_MODE_LABELS[mode])}
                            onValueChange={(label) =>
                                void updateSettings(client, { network: { proxyMode: proxyModeForLabel(label) } })
                            }
                        />
                    </Field>
                    {proxyMode === 'env' && (
                        <p className="mt-1 text-cell text-text-muted">
                            HTTPS_PROXY, HTTP_PROXY and NO_PROXY are read the way kubectl reads them, from your login
                            shell as well as this window, so a launch from the Dock proxies what a terminal would.
                        </p>
                    )}
                    {proxyMode === 'manual' && (
                        <Field label="Proxy URL" hint="http, https or socks5">
                            <FormInput
                                value={proxyUrl}
                                placeholder="http://proxy.example:3128"
                                validate={isProxyUrl}
                                onCommit={(value) =>
                                    void updateSettings(client, { network: { proxyUrl: value || null } })
                                }
                            />
                        </Field>
                    )}
                    {proxyMode !== 'off' && (
                        <Field label="Never proxy these hosts" hint="Comma separated, as NO_PROXY spells it">
                            <FormInput
                                value={noProxy}
                                placeholder=".corp.example, 10.0.0.0/8"
                                onCommit={(value) =>
                                    void updateSettings(client, { network: { noProxy: value || null } })
                                }
                            />
                        </Field>
                    )}
                </FormCard>

                <FormCard
                    title="Certificate authority"
                    desc="Certificates to trust for cluster TLS beside the usual ones, for a private authority or a proxy that inspects traffic."
                >
                    <Field
                        label="CA bundle"
                        hint="Choosing a file goes through a native dialog; the app never accepts a typed path."
                    >
                        <div className="flex flex-col gap-2">
                            <span
                                className="truncate font-mono text-cell text-text-2"
                                title={caBundlePath ?? undefined}
                                data-testid="ca-bundle-path"
                            >
                                {caBundlePath ?? 'The system certificate authorities only'}
                            </span>
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={connectionBusy}
                                    onClick={() => void runConnection(() => pickCaBundle(client))}
                                >
                                    Choose file…
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={connectionBusy || !caBundlePath}
                                    onClick={() => void runConnection(() => clearCaBundle(client))}
                                >
                                    Clear
                                </Button>
                            </div>
                        </div>
                    </Field>
                </FormCard>
            </Section>
        </SettingsPage>
    );
}

/** This install's version and the updater's outcome, with the check the user can start. */
function AboutCard() {
    const info = useIpcQuery('app.info', {});
    const { state, check } = useUpdater();
    const [checking, setChecking] = useState(false);
    const { title, detail } = describeUpdate(state);

    const runCheck = async () => {
        setChecking(true);
        try {
            await check();
        } finally {
            setChecking(false);
        }
    };

    return (
        <FormCard
            title="About"
            desc="This install and its update status."
            action={
                <Button
                    variant="outline"
                    size="sm"
                    disabled={checking || state?.status === 'unsupported'}
                    onClick={() => void runCheck()}
                >
                    Check for updates
                </Button>
            }
        >
            <div className="flex flex-col gap-2" data-testid="about-card">
                <div className="flex items-center gap-2 text-lead font-medium">
                    <span>{info.data?.name ?? 'Kubermeister'}</span>
                    <span className="font-mono text-body text-text-2">{info.data?.version ?? '—'}</span>
                </div>
                {info.data && (
                    <div className="text-meta text-text-muted">
                        Electron {info.data.electron} · Chrome {info.data.chrome} · Node {info.data.node}
                    </div>
                )}
                <div className="mt-1 flex flex-col gap-1 text-cell" data-testid="update-status">
                    <span>{title}</span>
                    {detail && <span className="whitespace-pre-wrap text-text-muted">{detail}</span>}
                </div>
                <div className="flex items-center gap-2 empty:hidden">
                    {state?.status === 'available' && (
                        <Button size="sm" onClick={() => void downloadUpdate()}>
                            Download update
                        </Button>
                    )}
                    {state?.status === 'downloaded' && (
                        <Button size="sm" onClick={() => void installUpdate()}>
                            Restart now
                        </Button>
                    )}
                    {/* The changelog is not in the app at all, so every card naming a version links to it. */}
                    {state?.version && state.status !== 'error' && (
                        // A package the system owns is fetched from the release page by hand, so for
                        // that state the link is the action rather than a footnote beside one.
                        <Button size="sm" variant={state.status === 'manual' ? 'default' : 'ghost'} asChild>
                            <a href={releasePageUrl(state.version)} target="_blank" rel="noreferrer">
                                {state.status === 'manual' ? 'Get the update' : <>What&apos;s new</>}
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    )}
                    {/* The version and the platform are on this very card, so the form arrives with
                        them filled in rather than asking the reporter to copy them across. */}
                    {info.data && (
                        <Button size="sm" variant="ghost" asChild>
                            <a href={bugReportUrl(info.data)} target="_blank" rel="noreferrer">
                                Report a bug
                                <ExternalLinkIcon />
                            </a>
                        </Button>
                    )}
                </div>
            </div>
        </FormCard>
    );
}
