export declare function fixturePath(relative?: string): string
export declare function fixtureFileUrl(relative?: string): string
export declare const fixtureYear: number
export declare function fixtureTime(offset?: number): number
export declare function fixtureIso(offset?: number, shape?: 'full' | 'date' | 'local-minute' | 'minute' | 'second' | 'zone-second' | 'zone-minute', zoneMinutes?: number): string
export declare function fixtureCivil(month: number, day: number, yearDelta?: number): string
export declare function fixtureData(value: unknown): any

export function fixturePsBirth(offset?: number): string

export declare function fixtureClock(hour: number, minute?: number, second?: number, fraction?: number, precision?: number): string
