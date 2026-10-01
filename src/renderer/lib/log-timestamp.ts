/**
 * The API server stamps a log line in UTC with nanoseconds (`2026-10-01T11:46:59.091078241Z`), which
 * is thirty columns of a narrow console spent mostly on digits nobody reads, in a zone the reader
 * has to convert. The console shows the same instant in the reader's own zone to the millisecond,
 * with the offset kept so the stamp still names one moment: `2026-10-01T15:46:59.091+04:00`.
 */

// Date parses at most milliseconds reliably, so the fraction is cut to three digits first.
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3})\d*)?(Z|[+-]\d{2}:\d{2})$/i;

function pad(value: number, width = 2): string {
    return String(value).padStart(width, '0');
}

/** A stamp the API server did not write in RFC 3339 is shown as it came rather than dropped. */
export function formatLogTimestamp(timestamp: string): string {
    const parts = RFC3339.exec(timestamp);
    if (!parts) return timestamp;
    const [, seconds, fraction = '', zone] = parts;
    const date = new Date(`${seconds}.${fraction.padEnd(3, '0')}${zone!.toUpperCase()}`);
    if (Number.isNaN(date.getTime())) return timestamp;

    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const zoneText = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
        `.${pad(date.getMilliseconds(), 3)}${zoneText}`
    );
}
