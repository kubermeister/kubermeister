import { useQueryClient } from '@tanstack/react-query';
import { SettingsFileCard } from '@/components/settings/settings-file-card';
import { FormCard, Toggle } from '@/components/templates/settings-form';
import { updateSettings, useSettings } from '@/lib/settings';

/** How the app itself behaves: the file it reads, where it reopens and whether quitting asks. */
export function GeneralSection() {
    const client = useQueryClient();
    const { data: settings } = useSettings();

    return (
        <>
            <SettingsFileCard />

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

            <FormCard
                title="Confirm before quitting"
                desc="Quitting ends every port forward, shell session, log follow and drain at once."
                action={
                    <Toggle
                        label="Confirm before quitting"
                        checked={settings?.general.confirmQuit ?? true}
                        onCheckedChange={(confirmQuit) => void updateSettings(client, { general: { confirmQuit } })}
                    />
                }
            >
                <p className="text-cell text-text-muted">
                    None of it comes back on the next launch. The dialog&apos;s own Don&apos;t ask again turns this off
                    too.
                </p>
            </FormCard>
        </>
    );
}
