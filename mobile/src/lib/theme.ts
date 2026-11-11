/** PiVault is dark-only: photos look best on black, and it keeps the design simple. */
export const colors = {
  bg: '#0B0D10',
  surface: '#15181D',
  surfaceRaised: '#1E2229',
  border: '#2A2F38',
  text: '#F2F4F7',
  textDim: '#9AA3AF',
  textFaint: '#6B7480',
  accent: '#4F8CFF',
  accentDim: '#1D3A6E',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
  overlay: 'rgba(0,0,0,0.6)',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const font = {
  title: { fontSize: 28, fontWeight: '700' as const, color: colors.text },
  heading: { fontSize: 18, fontWeight: '600' as const, color: colors.text },
  body: { fontSize: 16, color: colors.text },
  small: { fontSize: 13, color: colors.textDim },
  tiny: { fontSize: 11, color: colors.textDim },
};

/** Screens never grow wider than this on tablets and the web. */
export const maxContentWidth = 720;
