interface FooterProps {
  text?: string;
}

/**
 * Footer Component
 * Simple footer for webapp pages (optional)
 */
export default function Footer({ text }: FooterProps) {
  if (!text) return null;

  return (
    <footer>
      <style jsx>{`
        footer {
          padding: 20px;
          text-align: center;
          color: #6b7280;
          font-size: 14px;
          background: white;
        }
      `}</style>
      <p>{text}</p>
    </footer>
  );
}
