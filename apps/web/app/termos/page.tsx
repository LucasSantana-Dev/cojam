import type { Metadata } from 'next';
import { LegalPage } from '@/app/components/LegalPage';

export const metadata: Metadata = {
  title: 'Termos de Uso',
  description:
    'Regras de uso do CoJam: idade mínima, uso aceitável, moderação, e o fato de que o CoJam transmite apenas metadados, nunca áudio.',
  alternates: { canonical: '/termos' },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Termos de Uso"
      intro="Ao usar o CoJam você concorda com estes termos. Se não concordar, não use o serviço."
    >
      <h2>1. O que é o CoJam</h2>
      <p>
        O CoJam permite que pessoas em serviços de música diferentes ouçam juntas em uma sala. O
        CoJam sincroniza <strong>apenas metadados</strong> (fila, votos, faixa atual) e{' '}
        <strong>nunca transmite áudio ou vídeo</strong>. Cada pessoa toca a música na própria
        conta, pelo SDK do próprio serviço.
      </p>
      <p>
        Responsável pelo serviço: <code>[[CONTROLADOR: nome]]</code>. Contato:{' '}
        <code>[[EMAIL DE CONTATO DPO]]</code>.
      </p>

      <h2>2. Idade mínima</h2>
      <p>
        Para entrar em salas encontradas no diretório público é preciso ter ao menos 16 anos
        (autodeclaração). <code>[[REVISAR: idade mínima e regras para menores]]</code> Você
        também precisa cumprir a idade mínima exigida pelo serviço de música que usar.
      </p>

      <h2>3. Acesso e identidade</h2>
      <p>
        Hoje o acesso é como convidado, sem conta. Quem tem o link de uma sala pode entrar nela:
        não compartilhe links de salas que você quer manter privadas. Você é responsável pelo
        nome de exibição que escolher.
      </p>

      <h2>4. Uso aceitável</h2>
      <ul>
        <li>Não assedie, ameace, discrimine nem envie conteúdo ilegal, sexual envolvendo menores, ou que exponha dados de terceiros.</li>
        <li>Não use o serviço para spam, automação abusiva ou para tentar burlar limites e proteções.</li>
        <li>Não se passe por outra pessoa.</li>
        <li>Respeite os direitos autorais e os termos dos serviços de música que você conectar.</li>
      </ul>

      <h2>5. Moderação e remoção</h2>
      <p>
        O anfitrião de uma sala pode apagar mensagens e expulsar membros. Qualquer membro pode
        denunciar uma mensagem do chat pela função de denúncia da sala, e pode relatar membros ou
        salas ao contato indicado na seção 1. O operador pode
        remover conteúdo, encerrar salas e bloquear acessos que violem estes termos, a qualquer
        momento. Ações de moderação são registradas.
      </p>

      <h2>6. Serviços de terceiros</h2>
      <p>
        Spotify, YouTube e outros são serviços independentes. Sua relação com cada
        um é regida pelos termos e políticas deles, e o CoJam não os controla nem responde por
        eles. A reprodução de vídeo usa o player do YouTube no seu navegador.
      </p>

      <h2>7. Privacidade</h2>
      <p>
        O tratamento de dados pessoais está descrito na{' '}
        <a href="/privacidade">Política de Privacidade</a>.
      </p>

      <h2>8. Sem garantia</h2>
      <p>
        O CoJam é oferecido como está, sem garantia de disponibilidade, continuidade ou
        adequação a um fim específico. Salas e conversas são temporárias e podem desaparecer
        quando o servidor reinicia. <code>[[REVISAR: limitação de responsabilidade]]</code>
      </p>

      <h2>9. Mudanças</h2>
      <p>
        Estes termos podem mudar. A data no topo indica a última atualização, e o uso continuado
        após uma mudança significa que você a aceita.
      </p>

      <h2>10. Lei aplicável e foro</h2>
      <p>
        Lei brasileira. Foro: <code>[[FORO]]</code>.
      </p>
    </LegalPage>
  );
}
