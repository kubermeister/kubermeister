import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useFieldControl } from './field';

export function FormSelect({
    id,
    value,
    options,
    placeholder = 'None available',
    onValueChange,
}: {
    id?: string;
    value: string;
    options?: string[];
    placeholder?: string;
    onValueChange?: (value: string) => void;
}) {
    const { id: fieldId } = useFieldControl(id);
    // Radix rejects empty-string item values, so drop blanks; an empty source shows a disabled
    // placeholder rather than crashing.
    const items = (options ?? [value]).filter((o) => o.length > 0);
    if (items.length === 0) {
        return (
            <button
                type="button"
                id={fieldId}
                disabled
                className="flex h-8 w-full items-center rounded-md border border-border bg-elev-2 px-3 text-body text-text-muted"
            >
                {placeholder}
            </button>
        );
    }
    const controlledProps = onValueChange ? { value, onValueChange } : { defaultValue: value };
    return (
        <Select {...controlledProps}>
            <SelectTrigger id={fieldId} className="h-8 w-full text-body">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {items.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                        {opt}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

export function Toggle({
    checked,
    defaultChecked,
    disabled,
    onCheckedChange,
    label,
}: {
    checked?: boolean;
    defaultChecked?: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    label?: string;
}) {
    const controlledProps = checked !== undefined ? { checked, onCheckedChange } : { defaultChecked, onCheckedChange };
    return <Switch {...controlledProps} disabled={disabled} aria-label={label} />;
}

/**
 * A setting typed rather than chosen. It saves when the field is left or Enter is pressed, never on
 * every keystroke, so a half-typed address is not written to disk and sent to the cluster; Escape
 * puts the stored value back. A value `validate` refuses is marked and not saved, since the main
 * process would reject it as a bug rather than as a typo.
 */
export function FormInput({
    id,
    value,
    placeholder,
    validate,
    onCommit,
}: {
    id?: string;
    value: string;
    placeholder?: string;
    validate?: (value: string) => boolean;
    onCommit: (value: string) => void;
}) {
    const { id: fieldId } = useFieldControl(id);
    const [draft, setDraft] = useState(value);
    const [stored, setStored] = useState(value);
    // The saved value changed elsewhere (another write, a reload): start again from it.
    if (stored !== value) {
        setStored(value);
        setDraft(value);
    }
    const trimmed = draft.trim();
    const invalid = trimmed.length > 0 && validate ? !validate(trimmed) : false;

    const commit = () => {
        if (invalid || trimmed === value) return;
        onCommit(trimmed);
    };

    return (
        <Input
            id={fieldId}
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            aria-invalid={invalid || undefined}
            className="h-8 text-body"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }
                if (event.key === 'Escape') setDraft(value);
            }}
        />
    );
}
