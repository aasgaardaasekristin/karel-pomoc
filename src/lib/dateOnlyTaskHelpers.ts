export interface DueDateFlags {
  overdue: boolean;
  dueToday: boolean;
  dueSoon: boolean;
}

export function pragueTodayISO(referenceDate: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Prague",
  }).format(referenceDate);
}

export function shiftISODate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return shifted.toISOString().slice(0, 10);
}

export function getDueDateFlags(
  dueDate: string | null | undefined,
  referenceDate: Date = new Date(),
): DueDateFlags {
  const normalizedDueDate = typeof dueDate === "string" ? dueDate.slice(0, 10) : null;

  if (!normalizedDueDate) {
    return {
      overdue: false,
      dueToday: false,
      dueSoon: false,
    };
  }

  const today = pragueTodayISO(referenceDate);
  const tomorrow = shiftISODate(today, 1);

  return {
    overdue: normalizedDueDate < today,
    dueToday: normalizedDueDate === today,
    dueSoon: normalizedDueDate === tomorrow,
  };
}