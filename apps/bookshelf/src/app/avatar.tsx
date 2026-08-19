import { placeholder } from "@/lib/media";

/**
 * A profile's tile, tinted from its name. The same trick the shelf uses for
 * books with no cover, and for the same reason: no image to fetch, no upload
 * to manage, and two profiles never look alike.
 */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const { initials, hue } = placeholder(name);

  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white/90"
      style={{
        width: size,
        height: size,
        fontSize: size / 2.8,
        backgroundImage: `linear-gradient(hsl(${hue} 42% 58%), hsl(${(hue + 40) % 360} 44% 38%))`,
      }}
    >
      {initials}
    </span>
  );
}
