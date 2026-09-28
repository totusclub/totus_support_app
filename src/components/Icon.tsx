// Линейные иконки 24×24 (stroke 1.8) — тот же набор, что в calling_v2/components/Icon.tsx
// (phone, phoneOff, mic, volume, chat, user, users, refresh, close, search, send, …).
import React from 'react';
import Svg, {Circle, Line, Path, Polyline, Rect} from 'react-native-svg';

export type IconName =
  | 'phone'
  | 'phoneOff'
  | 'phoneIncoming'
  | 'phoneOutgoing'
  | 'phoneMissed'
  | 'mic'
  | 'micOff'
  | 'volume'
  | 'chat'
  | 'user'
  | 'users'
  | 'refresh'
  | 'close'
  | 'search'
  | 'send'
  | 'chevronLeft'
  | 'chevronRight'
  | 'minimize'
  | 'logout'
  | 'lock'
  | 'unlock'
  | 'server'
  | 'history'
  | 'check'
  | 'checks';

interface Props {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

export default function Icon({name, size = 24, color, strokeWidth = 1.8}: Props) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  const phonePath =
    'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z';
  const content = (() => {
    switch (name) {
      case 'phone':
        return <Path d={phonePath} {...common} />;
      case 'phoneIncoming':
        return (
          <>
            <Path d={phonePath} {...common} />
            <Polyline points="16 2 16 8 22 8" {...common} />
            <Line x1="23" y1="1" x2="16" y2="8" {...common} />
          </>
        );
      case 'phoneOutgoing':
        return (
          <>
            <Path d={phonePath} {...common} />
            <Polyline points="23 7 23 1 17 1" {...common} />
            <Line x1="16" y1="8" x2="23" y2="1" {...common} />
          </>
        );
      case 'phoneMissed':
        return (
          <>
            <Path d={phonePath} {...common} />
            <Line x1="23" y1="1" x2="17" y2="7" {...common} />
            <Line x1="17" y1="1" x2="23" y2="7" {...common} />
          </>
        );
      case 'phoneOff':
        return (
          <>
            <Path
              d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"
              {...common}
            />
            <Line x1="23" y1="1" x2="1" y2="23" {...common} />
          </>
        );
      case 'mic':
        return (
          <>
            <Rect x="9" y="2" width="6" height="12" rx="3" {...common} />
            <Path d="M19 10v1a7 7 0 0 1-14 0v-1" {...common} />
            <Line x1="12" y1="18" x2="12" y2="22" {...common} />
          </>
        );
      case 'micOff':
        return (
          <>
            <Line x1="1" y1="1" x2="23" y2="23" {...common} />
            <Path d="M9 9v2a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" {...common} />
            <Path d="M17 16.95A7 7 0 0 1 5 11v-1m14 0v1a7 7 0 0 1-.11 1.23" {...common} />
            <Line x1="12" y1="18" x2="12" y2="22" {...common} />
          </>
        );
      case 'volume':
        return (
          <>
            <Path d="M11 5 6 9H2v6h4l5 4V5z" {...common} />
            <Path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14" {...common} />
          </>
        );
      case 'chat':
        return <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" {...common} />;
      case 'user':
        return (
          <>
            <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" {...common} />
            <Circle cx="12" cy="7" r="4" {...common} />
          </>
        );
      case 'users':
        return (
          <>
            <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...common} />
            <Circle cx="9" cy="7" r="4" {...common} />
            <Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" {...common} />
          </>
        );
      case 'refresh':
        return (
          <>
            <Polyline points="23 4 23 10 17 10" {...common} />
            <Polyline points="1 20 1 14 7 14" {...common} />
            <Path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" {...common} />
          </>
        );
      case 'close':
        return (
          <>
            <Line x1="18" y1="6" x2="6" y2="18" {...common} />
            <Line x1="6" y1="6" x2="18" y2="18" {...common} />
          </>
        );
      case 'search':
        return (
          <>
            <Circle cx="11" cy="11" r="8" {...common} />
            <Line x1="21" y1="21" x2="16.65" y2="16.65" {...common} />
          </>
        );
      case 'send':
        return (
          <>
            <Line x1="22" y1="2" x2="11" y2="13" {...common} />
            <Path d="M22 2 15 22l-4-9-9-4 20-7z" {...common} />
          </>
        );
      case 'chevronLeft':
        return <Polyline points="15 18 9 12 15 6" {...common} />;
      case 'chevronRight':
        return <Polyline points="9 18 15 12 9 6" {...common} />;
      case 'minimize':
        return <Polyline points="6 9 12 15 18 9" {...common} />;
      case 'logout':
        return (
          <>
            <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...common} />
            <Polyline points="16 17 21 12 16 7" {...common} />
            <Line x1="21" y1="12" x2="9" y2="12" {...common} />
          </>
        );
      case 'lock':
        return (
          <>
            <Rect x="3" y="11" width="18" height="11" rx="2" {...common} />
            <Path d="M7 11V7a5 5 0 0 1 10 0v4" {...common} />
          </>
        );
      case 'unlock':
        return (
          <>
            <Rect x="3" y="11" width="18" height="11" rx="2" {...common} />
            <Path d="M7 11V7a5 5 0 0 1 9.9-1" {...common} />
          </>
        );
      case 'server':
        return (
          <>
            <Rect x="2" y="2" width="20" height="8" rx="2" {...common} />
            <Rect x="2" y="14" width="20" height="8" rx="2" {...common} />
            <Line x1="6" y1="6" x2="6.01" y2="6" {...common} />
            <Line x1="6" y1="18" x2="6.01" y2="18" {...common} />
          </>
        );
      case 'history':
        return (
          <>
            <Path d="M3 3v5h5" {...common} />
            <Path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" {...common} />
            <Polyline points="12 7 12 12 15 15" {...common} />
          </>
        );
      case 'check':
        return <Polyline points="20 6 9 17 4 12" {...common} />;
      case 'checks':
        return (
          <>
            <Polyline points="17 6 7 16 3 12" {...common} />
            <Polyline points="22 6 12 16 11 15" {...common} />
          </>
        );
      default:
        return null;
    }
  })();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {content}
    </Svg>
  );
}
