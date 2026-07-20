'use client';

// CoJam mark: "Two Listeners" (ADR-0004). Two-color: the headphone FRAME is the
// violet identity sweep; the CORE (badge + wave) is the music-green accent.
// `animated` makes both gradients flow slowly (colors moving = in sync); it is
// SSR-safe (renders static first) and disabled under prefers-reduced-motion.
import { useId, useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
const getReducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;
// Server + first client render assume motion is allowed (static logo).
const getReducedMotionServer = () => false;

const MARK =
  'M 165.0 699.7 C 181.7 693.9 193.8 680.2 196.9 663.6 C 198.3 655.7 198.4 457.6 197.0 450.0 C 194.4 436.4 183.4 422.2 170.7 416.2 C 167.0 414.4 162.6 413.0 161.0 413.0 C 157.5 413.0 157.3 412.1 159.5 404.7 C 160.4 401.8 162.0 396.4 163.2 392.5 C 166.2 382.2 169.0 374.0 171.1 369.3 C 172.2 366.9 173.0 364.8 173.0 364.6 C 173.0 362.0 189.4 331.4 196.9 320.0 C 198.9 317.0 200.9 313.7 201.5 312.8 C 205.1 306.6 224.1 283.9 234.4 273.5 C 256.7 251.0 282.6 232.1 310.4 218.1 C 318.7 213.9 326.9 209.9 328.5 209.3 C 356.1 198.7 368.6 195.2 392.6 191.1 C 465.8 178.7 541.7 195.8 603.0 238.7 C 632.0 259.0 661.2 288.6 679.7 316.5 C 688.7 330.1 690.5 333.1 697.4 347.0 C 705.4 363.0 709.2 372.5 714.0 387.5 C 722.3 413.9 722.1 412.3 716.2 413.7 C 713.6 414.3 709.2 415.8 706.4 417.1 C 699.8 420.2 689.2 431.0 685.7 438.3 C 679.8 450.5 679.9 448.7 680.2 560.3 L 680.5 662.5 L 682.8 668.9 C 688.8 685.5 700.2 695.7 718.2 700.5 C 723.6 701.9 727.3 702.2 737.2 701.7 C 769.4 700.3 795.2 689.1 817.0 667.1 C 844.5 639.4 858.0 602.7 858.0 556.0 C 858.0 530.6 854.4 510.3 846.6 490.7 C 832.4 455.6 805.2 428.9 772.9 418.4 C 768.3 416.9 764.4 415.6 764.3 415.5 C 764.1 415.4 763.1 410.9 762.0 405.4 C 749.2 342.4 716.9 282.8 670.5 236.5 C 636.2 202.1 600.6 178.3 556.0 159.7 C 496.6 135.1 426.1 130.0 364.0 146.1 C 350.6 149.5 327.9 156.8 326.6 158.1 C 326.0 158.6 324.9 159.0 324.1 159.0 C 320.8 159.0 292.4 172.9 277.1 182.0 C 218.1 217.0 172.4 266.1 143.2 326.0 C 132.0 349.1 120.9 380.5 117.1 400.0 C 114.0 415.6 113.9 415.9 110.0 416.6 C 105.1 417.5 89.9 424.2 82.6 428.6 C 57.4 444.0 38.4 468.7 28.0 499.6 C 21.6 518.5 20.5 526.8 20.5 557.0 C 20.6 581.9 20.8 585.4 22.8 594.0 C 26.9 611.4 34.1 630.5 40.2 640.5 C 47.4 652.1 52.0 658.1 61.0 667.1 C 78.7 685.0 97.0 694.8 121.0 699.3 C 125.7 700.2 130.4 701.1 131.5 701.4 C 132.6 701.6 139.1 701.8 146.0 701.8 C 156.5 701.9 159.6 701.6 165.0 699.7 Z M 465.0 738.9 C 527.1 730.8 585.0 689.5 612.8 633.4 C 620.2 618.7 629.0 594.8 629.0 589.7 C 629.0 589.3 621.9 589.1 613.3 589.2 L 597.5 589.5 L 593.0 601.5 C 583.9 625.4 573.0 642.1 554.5 660.5 C 547.4 667.7 539.5 674.9 537.0 676.6 C 534.5 678.3 530.5 681.0 528.0 682.7 C 525.5 684.4 518.8 688.3 513.0 691.3 C 470.8 713.5 416.9 714.8 372.7 694.6 C 354.4 686.3 340.2 676.5 325.6 662.2 C 307.4 644.3 297.1 628.7 286.5 602.8 C 280.3 587.8 278.9 585.6 273.4 581.8 C 270.1 579.4 267.8 578.8 258.7 577.9 C 252.5 577.2 247.5 577.1 247.0 577.6 C 245.8 578.9 252.5 604.5 256.4 613.5 C 257.1 615.1 258.8 619.0 260.1 622.0 C 275.3 657.5 304.3 690.8 338.0 711.6 C 346.1 716.6 366.5 726.6 370.5 727.6 C 372.2 728.0 373.9 728.6 374.5 729.0 C 376.3 730.4 397.2 736.0 406.0 737.5 C 425.7 741.0 445.8 741.4 465.0 738.9 Z M 487.0 628.2 C 498.9 622.9 509.5 607.8 516.5 586.3 C 520.3 574.7 520.4 574.2 526.0 552.0 C 533.4 521.9 538.3 508.3 541.3 509.3 C 542.5 509.7 545.7 515.6 551.6 528.5 C 558.3 543.1 568.4 555.1 579.1 561.3 C 588.6 566.9 596.5 568.0 626.4 568.0 C 641.3 568.0 654.1 567.6 654.8 567.2 C 655.7 566.5 656.0 562.7 655.8 551.4 L 655.5 536.5 L 629.0 536.0 C 603.8 535.5 602.2 535.4 597.2 533.1 C 590.7 530.2 584.9 523.8 580.8 515.0 C 570.2 492.3 568.7 489.7 563.8 484.8 C 560.9 481.9 556.0 478.5 552.3 476.8 C 546.6 474.1 545.1 473.8 539.1 474.2 C 530.7 474.8 525.0 477.9 517.7 486.0 C 508.4 496.4 502.0 512.1 494.6 543.5 C 487.4 573.7 480.3 593.9 476.4 595.4 C 473.7 596.4 473.1 596.1 470.7 592.2 C 466.0 584.7 461.2 570.4 450.0 529.5 C 444.4 509.1 441.7 501.6 436.5 491.3 C 431.1 480.5 424.8 473.2 417.2 468.8 C 411.9 465.8 410.8 465.5 403.0 465.5 C 395.8 465.6 393.7 466.0 389.5 468.2 C 375.2 475.7 365.8 491.0 359.5 517.0 C 347.2 567.3 340.4 587.9 336.6 586.7 C 336.0 586.5 331.7 578.7 327.0 569.4 C 322.3 560.0 317.5 551.0 316.2 549.4 C 311.0 542.9 303.2 535.6 298.0 532.6 C 285.1 525.1 276.1 523.7 244.8 524.2 L 222.5 524.5 L 222.2 540.6 L 222.0 556.8 L 248.7 557.2 C 275.3 557.6 275.5 557.6 280.6 560.3 C 287.2 563.7 290.4 567.5 295.2 578.0 C 305.1 599.3 307.5 603.4 314.0 610.2 C 338.4 635.0 366.2 619.4 378.5 574.0 C 379.3 571.0 382.4 558.6 385.4 546.5 C 392.6 517.8 398.1 501.3 401.1 499.4 C 401.7 499.1 403.0 499.6 404.2 500.7 C 408.9 504.9 413.7 518.1 422.0 549.0 C 433.3 591.8 438.5 604.7 449.5 617.5 C 459.5 629.2 474.9 633.6 487.0 628.2 Z M 631.4 516.2 C 633.0 513.6 625.3 486.5 618.5 471.2 C 592.1 411.3 537.3 367.8 473.0 355.9 C 455.3 352.6 424.1 352.5 406.5 355.8 C 379.6 360.7 354.7 370.7 332.5 385.6 C 307.1 402.6 284.1 426.8 269.9 451.6 C 261.9 465.5 251.1 492.2 249.9 501.0 L 249.5 503.5 L 265.8 503.5 L 282.2 503.5 L 286.4 492.0 C 295.7 467.0 309.6 446.2 329.6 427.7 C 379.8 381.1 459.2 371.6 518.2 405.0 C 554.2 425.4 575.9 450.6 595.0 494.2 C 601.4 508.8 606.5 513.8 617.3 515.9 C 622.8 517.0 630.8 517.2 631.4 516.2 Z M 432.0 175.2 C 421.3 169.9 421.3 154.4 432.1 149.0 C 437.1 146.4 441.6 146.5 446.4 149.3 C 456.3 154.9 456.5 169.1 446.8 175.0 C 442.7 177.5 436.6 177.6 432.0 175.2 Z';

export function LogoMark({
  size = 16,
  glow = false,
  animated = false,
}: {
  size?: number;
  glow?: boolean;
  animated?: boolean;
}) {
  const raw = useId().replace(/:/g, '');
  const frame = `cjF-${raw}`;
  const core = `cjC-${raw}`;
  const badge = `cjB-${raw}`;

  // Static on the server + first client render (server snapshot is false);
  // flow is enabled only when requested and motion is allowed.
  const reduceMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, getReducedMotionServer);
  const flow = animated && !reduceMotion;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 878 878"
      fill="none"
      aria-hidden
      focusable="false"
      style={glow ? { filter: 'drop-shadow(0 0 14px rgba(160,107,255,0.45))' } : undefined}
    >
      <defs>
        {flow ? (
          <>
            <linearGradient id={frame} x1="20" y1="439" x2="440" y2="439" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
              <stop offset="0" stopColor="var(--logo-frame-from, #6d5cff)" />
              <stop offset="0.5" stopColor="var(--logo-frame-to, #c661ff)" />
              <stop offset="1" stopColor="var(--logo-frame-from, #6d5cff)" />
              <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="420 0" dur="9s" repeatCount="indefinite" />
            </linearGradient>
            <linearGradient id={core} x1="439" y1="380" x2="439" y2="640" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
              <stop offset="0" stopColor="var(--logo-core-from, #a3e635)" />
              <stop offset="0.5" stopColor="var(--logo-core-to, #10b981)" />
              <stop offset="1" stopColor="var(--logo-core-from, #a3e635)" />
              <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="0 260" dur="7s" repeatCount="indefinite" />
            </linearGradient>
          </>
        ) : (
          <>
            <linearGradient id={frame} x1="20" y1="439" x2="858" y2="439" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--logo-frame-from, #6d5cff)" />
              <stop offset="1" stopColor="var(--logo-frame-to, #c661ff)" />
            </linearGradient>
            <linearGradient id={core} x1="439" y1="360" x2="439" y2="720" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--logo-core-from, #a3e635)" />
              <stop offset="1" stopColor="var(--logo-core-to, #10b981)" />
            </linearGradient>
          </>
        )}
        <clipPath id={badge}>
          <circle cx="439" cy="545" r="212" />
        </clipPath>
      </defs>
      <path d={MARK} fill={`url(#${frame})`} fillRule="evenodd" />
      <path d={MARK} fill={`url(#${core})`} fillRule="evenodd" clipPath={`url(#${badge})`} />
    </svg>
  );
}
