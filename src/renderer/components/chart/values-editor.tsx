import type { ChartValues } from '../../../shared/chart-values';
import { YamlEditor } from '@/components/data-display/yaml-editor';
import { useValuesChecks, type ValuesRenderError } from '@/lib/values-diagnostics';
import { cn } from '@/lib/utils';

/**
 * The values a chart renders with, edited as YAML against the chart's own `values.schema.json`:
 * what the schema refuses is marked as it is typed, the schema completes keys and values, and a
 * render Helm refused is laid over the values it refused, each problem on the value it names. A
 * chart with no schema is plain YAML. Controlled: the screen holds the text and starts it from the
 * chart's `values.yaml`.
 */
export function ChartValuesEditor({
    chart,
    value,
    onValueChange,
    renderError = null,
    className,
}: {
    chart: ChartValues;
    value: string;
    onValueChange: (value: string) => void;
    /** The last render, when it failed; shown while the text is still the one it was rendered from. */
    renderError?: ValuesRenderError | null;
    className?: string;
}) {
    const checks = useValuesChecks(value, chart, renderError);
    const failed = checks.renderError;
    return (
        <div className={cn('flex min-h-0 flex-col', className)}>
            {chart.schemaProblem && (
                <p
                    className="border-b border-border bg-warn-bg px-3.5 py-2 text-cell text-warn"
                    data-testid="values-schema-problem"
                >
                    {chart.schemaProblem} The values are checked as YAML only.
                </p>
            )}
            {failed && (
                <div
                    role="alert"
                    className="flex flex-col gap-1 border-b border-border bg-danger-bg px-3.5 py-2 text-cell text-danger"
                    data-testid="values-render-error"
                >
                    <p className="font-medium">
                        {failed.summary}
                        {failed.diagnostics.length > 0 && ' The values it names are marked below.'}
                    </p>
                    {failed.notes.length > 0 && (
                        <ul className="flex flex-col gap-0.5">
                            {failed.notes.map((note, index) => (
                                <li key={index}>
                                    {note.message}
                                    {note.where && <span className="font-mono text-meta"> · {note.where}</span>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            <YamlEditor
                value={value}
                onValueChange={onValueChange}
                diagnostics={checks.diagnostics}
                schema={checks.lens}
                aria-label="Chart values"
                className="min-h-0 flex-1"
            />
        </div>
    );
}
