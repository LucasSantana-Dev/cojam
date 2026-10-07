export function PlayFailedTrack() {
  return (
    <div className="hero-unavailable">
      <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Não deu para tocar esta faixa no seu serviço
      </p>
      <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
        A faixa pode ter sido removida ou estar restrita no serviço conectado. Outras pessoas na sala ainda podem estar ouvindo.
      </p>
    </div>
  );
}
