import { useQueryClient } from '@tanstack/react-query';
import {
    DEFAULT_UPDATE_MODE,
    UPDATE_CHECK_INTERVAL_OPTIONS,
    UPDATE_MODES,
    type UpdateMode,
} from '../../../shared/settings';
import { Field, FormCard, FormSelect } from '@/components/templates/settings-form';
import { updateSettings, useSettings } from '@/lib/settings';

const UPDATE_MODE_LABELS: Record<UpdateMode, string> = {
    check: 'Notify me and let me choose',
    download: 'Download in the background',
    off: 'Never check automatically',
};
const modeForLabel = (label: string): UpdateMode =>
    UPDATE_MODES.find((mode) => UPDATE_MODE_LABELS[mode] === label) ?? DEFAULT_UPDATE_MODE;

const checkIntervalLabel = (hours: number) =>
    hours === 1
        ? 'Every hour'
        : hours === 24
          ? 'Once a day'
          : hours % 24 === 0
            ? `Every ${hours / 24} days`
            : `Every ${hours} hours`;

/** What the app does about new versions of itself. */
export function UpdatesSection() {
    const client = useQueryClient();
    const { data: settings } = useSettings();
    const updateMode = settings?.updates.mode ?? DEFAULT_UPDATE_MODE;
    const checkIntervalHours = settings?.updates.checkIntervalHours ?? 4;
    const checkIntervals = Array.from(new Set<number>([...UPDATE_CHECK_INTERVAL_OPTIONS, checkIntervalHours])).sort(
        (a, b) => a - b,
    );
    const checkIntervalByLabel = new Map(checkIntervals.map((hours) => [checkIntervalLabel(hours), hours]));

    return (
        <FormCard title="Automatic updates" desc="What happens when a new version of Kubermeister is found.">
            <Field label="When a new version is found">
                <FormSelect
                    value={UPDATE_MODE_LABELS[updateMode]}
                    options={UPDATE_MODES.map((mode) => UPDATE_MODE_LABELS[mode])}
                    onValueChange={(label) => void updateSettings(client, { updates: { mode: modeForLabel(label) } })}
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
    );
}
