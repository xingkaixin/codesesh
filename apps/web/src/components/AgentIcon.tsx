/**
 * Renders an agent icon from AgentInfo. SVGs loaded via <img> cannot inherit
 * the page's CSS color, so monochrome icons are painted with a CSS mask over
 * currentColor to follow the surrounding text color in both themes. Icons
 * flagged iconColored keep their brand colors and render as a plain <img>.
 */
export function AgentIcon({
  icon,
  iconColored,
  alt,
  className,
}: {
  icon: string;
  iconColored?: boolean;
  alt: string;
  className?: string;
}) {
  if (iconColored) {
    return <img src={icon} alt={alt} className={className} />;
  }
  const mask = `url("${icon}") center / contain no-repeat`;
  return (
    <span
      role="img"
      aria-label={alt}
      className={`inline-block bg-current ${className ?? ""}`}
      style={{ mask, WebkitMask: mask }}
    />
  );
}
