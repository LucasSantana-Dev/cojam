'use client';

// Fixed preview panel (only with ?preview=1) to flip the four brand axes live.
// Each change updates the <html> attribute and the URL, so the state is linkable.
import { AXES, AXIS_DEFAULTS, type AxisName } from '@/lib/brandAxesConfig';
import { setAxis, useAxis, usePreviewMode } from '@/lib/brandAxes';

const LABELS: Record<AxisName, { title: string; values: Record<string, string> }> = {
  fx: { title: 'Efeitos', values: { current: 'atual', flat: 'plano' } },
  ground: { title: 'Fundo', values: { default: 'atual', black: 'preto', indigo: 'índigo' } },
  presence: { title: 'Presença', values: { none: 'nenhuma', key: 'chave', all: 'toda' } },
  wordmark: {
    title: 'Marca',
    values: { text: 'texto', 'lockup-a': 'A', 'lockup-b': 'B', 'lockup-c': 'C' },
  },
};

function Row({ axis }: { axis: AxisName }) {
  const current = useAxis(axis);
  const options = axis === 'ground' ? ['default', ...AXES.ground] : [...AXES[axis]];
  return (
    <div role="group" aria-label={LABELS[axis].title} className="axes-switcher__row">
      <span className="axes-switcher__title">{LABELS[axis].title}</span>
      <span className="axes-switcher__opts">
        {options.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={current === v}
            data-axis-option={`${axis}:${v}`}
            onClick={() => setAxis(axis, v as never)}
          >
            {LABELS[axis].values[v]}
          </button>
        ))}
      </span>
    </div>
  );
}

export function BrandAxesSwitcher() {
  const preview = usePreviewMode();
  if (!preview) return null;
  return (
    <aside className="axes-switcher" aria-label="Alternar eixos de marca (prévia)" data-preview-panel>
      <strong className="axes-switcher__head">Prévia de marca</strong>
      {(Object.keys(AXIS_DEFAULTS) as AxisName[]).map((a) => (
        <Row key={a} axis={a} />
      ))}
    </aside>
  );
}
