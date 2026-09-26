export const SEAT_COLORS: Record<string, string> = {
  red: '#ff5a6e',
  blue: '#4fa8ff',
  green: '#6dffa8',
  gold: '#ffd35a',
};

export function seatColor(seat: string | null | undefined): string {
  return (seat && SEAT_COLORS[seat]) || '#9aa1cf';
}
