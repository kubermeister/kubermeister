import { useDeferredValue, useMemo } from 'react';
import type { ChartValues } from '../../shared/chart-values';
import type { SchemaLens } from './manifest-completion';
import type { EditorDiagnostics } from './manifest-diagnostics';
import { placeRenderError, type PlacedRenderError } from './values-render-error';
import { valuesLens } from './values-schema';
import { chartDefaults, validateValues } from './values-validation';

/** A render that failed, with the values text it was rendered from, since only that text has its marks. */
export interface ValuesRenderError {
    values: string;
    /** Helm's own words, as the render step answers them. */
    message: string;
}

export interface ValuesChecks {
    diagnostics: EditorDiagnostics;
    /** The chart's schema as the editor reads it for completion; null for a chart with none. */
    lens: SchemaLens | null;
    /** The failed render, while the text is still the one it was rendered from. */
    renderError: PlacedRenderError | null;
}

/**
 * Check a chart's values as they are typed: against the chart's schema, which trails typing as the
 * manifest check does, and against the last render, whose marks stand only while the text is the
 * one Helm refused. An edit after it is an attempt at a fix, which only the next render can judge.
 */
export function useValuesChecks(text: string, chart: ChartValues, renderError: ValuesRenderError | null): ValuesChecks {
    const deferred = useDeferredValue(text);
    const defaults = useMemo(() => chartDefaults(chart.valuesYaml), [chart.valuesYaml]);
    const lens = useMemo(() => (chart.schema === null ? null : valuesLens(chart.schema)), [chart.schema]);
    const placed = useMemo(
        () => (renderError ? placeRenderError(renderError.values, renderError.message) : null),
        [renderError],
    );
    const diagnostics = useMemo(() => {
        const items = validateValues(deferred, chart.schema, defaults, chart.subcharts);
        const rendered = placed && renderError?.values === deferred ? placed.diagnostics : [];
        return { text: deferred, items: [...items, ...rendered].sort((a, b) => a.from - b.from) };
    }, [deferred, chart.schema, chart.subcharts, defaults, placed, renderError]);
    return { diagnostics, lens, renderError: renderError?.values === text ? placed : null };
}
