import { useQueryClient } from '@tanstack/react-query';
import { LOG_BUFFER_OPTIONS, READ_TIMEOUT_OPTIONS, REFRESH_INTERVAL_OPTIONS } from '../../../shared/settings';
import { Field, FormCard, FormSelect } from '@/components/templates/settings-form';
import { updateSettings, useSettings } from '@/lib/settings';

/** Thousands read better than five digits in a select; the label maps back to its own number. */
const bufferLabel = (lines: number): string => `${(lines / 1000).toLocaleString()}k lines`;
const BUFFER_BY_LABEL = new Map(LOG_BUFFER_OPTIONS.map((lines) => [bufferLabel(lines), lines]));

const intervalLabel = (sec: number) => `${sec} seconds`;

/** The presets plus the current value, so a non-preset one (the 12 s default) still renders as selected. */
const secondsOptions = (presets: readonly number[], current: number): string[] =>
    Array.from(new Set<number>([...presets, current]))
        .sort((a, b) => a - b)
        .map(intervalLabel);

/** How much the app asks of a cluster and keeps from it: poll cadence, read ceiling, log buffer. */
export function ClusterDataSection() {
    const client = useQueryClient();
    const { data: settings } = useSettings();
    const refreshSec = settings?.data.refreshIntervalSec ?? 12;
    const readTimeoutSec = settings?.data.readTimeoutSec ?? 60;
    const logBuffer = settings?.data.logBufferLines ?? 2_000;

    return (
        <>
            <FormCard title="Live data refresh" desc="How often lists, metrics and the dashboard poll for updates.">
                <Field label="Refresh interval">
                    <FormSelect
                        value={intervalLabel(refreshSec)}
                        options={secondsOptions(REFRESH_INTERVAL_OPTIONS, refreshSec)}
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
                        options={secondsOptions(READ_TIMEOUT_OPTIONS, readTimeoutSec)}
                        onValueChange={(label) =>
                            void updateSettings(client, { data: { readTimeoutSec: parseInt(label, 10) } })
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
        </>
    );
}
