import { useQueryClient } from '@tanstack/react-query';
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { TERMINAL_FONT_SIZES } from '../../../shared/settings';
import { Field, FormCard, FormSelect } from '@/components/templates/settings-form';
import { useTheme, type Theme } from '@/components/theme-provider';
import { updateSettings, useSettings } from '@/lib/settings';
import { cn } from '@/lib/utils';

const THEME_OPTIONS: { value: Theme; label: string; icon: LucideIcon; desc: string }[] = [
    { value: 'light', label: 'Light', icon: SunIcon, desc: 'Cobalt, bright surfaces' },
    { value: 'dark', label: 'Dark', icon: MoonIcon, desc: 'Cobalt, dense night mode' },
    { value: 'system', label: 'System', icon: MonitorIcon, desc: 'Match OS preference' },
];

/** How the window looks: the theme and the shell terminal's type. */
export function AppearanceSection() {
    const { theme, setTheme } = useTheme();
    const client = useQueryClient();
    const { data: settings } = useSettings();
    const terminalFont = settings?.data.terminalFontSize ?? 12;

    return (
        <>
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
        </>
    );
}
