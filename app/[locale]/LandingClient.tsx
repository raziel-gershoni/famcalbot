'use client';

import { useState, useEffect } from 'react';

interface RotatingHeadlineProps {
  headlines: string[];
}

export function RotatingHeadline({ headlines }: RotatingHeadlineProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setIsFading(true);

      setTimeout(() => {
        setCurrentIndex((prev) => (prev + 1) % headlines.length);
        setIsFading(false);
      }, 400);
    }, 4000);

    return () => clearInterval(interval);
  }, [headlines.length]);

  return (
    <span
      style={{
        transition: 'opacity 0.4s ease',
        opacity: isFading ? 0 : 1,
      }}
    >
      {headlines[currentIndex]}
    </span>
  );
}
