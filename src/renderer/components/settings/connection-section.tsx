import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PROXY_MODES, isProxyUrl, type ProxyMode } from '../../../shared/settings';
import { Field, FormCard, FormInput, FormSelect } from '@/components/templates/settings-form';
import { Button } from '@/components/ui/button';
import {
    clearCaBundle,
    pickCaBundle,
    pickKubeconfig,
    resetKubeconfig,
    updateSettings,
    useSettings,
} from '@/lib/settings';

const PROXY_MODE_LABELS: Record<ProxyMode, string> = {
    env: 'Follow the environment',
    manual: 'Use this proxy',
    off: 'Connect directly',
};
const proxyModeForLabel = (label: string): ProxyMode =>
    PROXY_MODES.find((mode) => PROXY_MODE_LABELS[mode] === label) ?? 'env';

/** What the app connects with: the kubeconfig, the proxy in between and the authorities it trusts. */
export function ConnectionSection() {
    const client = useQueryClient();
    const { data: settings } = useSettings();
    const [busy, setBusy] = useState(false);

    const kubeconfigPath = settings?.connection.kubeconfigPath ?? null;
    const proxyMode = settings?.network.proxyMode ?? 'env';
    const proxyUrl = settings?.network.proxyUrl ?? '';
    const noProxy = settings?.network.noProxy ?? '';
    const caBundlePath = settings?.network.caBundlePath ?? null;

    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try {
            await action();
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
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
                                disabled={busy}
                                onClick={() => void run(() => pickKubeconfig(client))}
                            >
                                Browse…
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !kubeconfigPath}
                                onClick={() => void run(() => resetKubeconfig(client))}
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
                        HTTPS_PROXY, HTTP_PROXY and NO_PROXY are read the way kubectl reads them, from your login shell
                        as well as this window, so a launch from the Dock proxies what a terminal would.
                    </p>
                )}
                {proxyMode === 'manual' && (
                    <Field label="Proxy URL" hint="http, https or socks5">
                        <FormInput
                            value={proxyUrl}
                            placeholder="http://proxy.example:3128"
                            validate={isProxyUrl}
                            onCommit={(value) => void updateSettings(client, { network: { proxyUrl: value || null } })}
                        />
                    </Field>
                )}
                {proxyMode !== 'off' && (
                    <Field label="Never proxy these hosts" hint="Comma separated, as NO_PROXY spells it">
                        <FormInput
                            value={noProxy}
                            placeholder=".corp.example, 10.0.0.0/8"
                            onCommit={(value) => void updateSettings(client, { network: { noProxy: value || null } })}
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
                                disabled={busy}
                                onClick={() => void run(() => pickCaBundle(client))}
                            >
                                Choose file…
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !caBundlePath}
                                onClick={() => void run(() => clearCaBundle(client))}
                            >
                                Clear
                            </Button>
                        </div>
                    </div>
                </Field>
            </FormCard>
        </>
    );
}
