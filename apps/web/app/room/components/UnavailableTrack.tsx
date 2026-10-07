export function UnavailableTrack() {
  return (
    <div className="hero-unavailable">
      <p className="text-lg font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Indisponível nos serviços conectados
      </p>
      <p className="text-sm mt-2" style={{ color: 'var(--color-text-secondary)' }}>
        Esta faixa não tem fonte compatível com os serviços que você conectou. Adicione outra faixa ou conecte outro serviço.
      </p>
    </div>
  );
}
