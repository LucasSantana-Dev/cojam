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
      led={{ title: 'TERMOS', sub: 'DE USO' }}
      intro="Ao usar o CoJam você concorda com estes termos. Se não concordar, não use o serviço."
    >
      <h2>1. O que é o CoJam</h2>
      <p>
        O CoJam permite que pessoas em serviços de música diferentes ouçam juntas em uma sala. O
        CoJam sincroniza <strong>apenas metadados</strong> (fila, votos, faixa atual) e{' '}
        <strong>nunca transmite áudio ou vídeo</strong> pelos seus servidores. Cada pessoa toca a
        música na própria conta, pelo SDK do próprio serviço. O compartilhamento de tela, quando
        disponível, vai direto entre os navegadores de quem participa (seção 5).
      </p>
      <p>
        Responsável pelo serviço: <code>[[CONTROLADOR: nome]]</code>. Contato:{' '}
        <code>[[EMAIL DE CONTATO DPO]]</code>.
      </p>

      <h2>2. Idade mínima</h2>
      <p>
        Para entrar em salas encontradas no diretório público é preciso ter ao menos 16 anos
        (autodeclaração). A mesma idade vale para transmitir ou assistir a um compartilhamento de
        tela. Você também precisa cumprir a idade mínima exigida pelo serviço de música que usar.
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

      <h2>5. Compartilhamento de tela</h2>
      <p>
        Quando disponível, o anfitrião de uma sala privada pode compartilhar a tela com até 5
        membros da sala. Ninguém recebe a imagem sem escolher assistir. A imagem e o som vão direto
        do seu navegador para o de quem assiste: o CoJam não vê, não grava e não modera a
        transmissão ao vivo, e cada participante vê o endereço de rede (IP) do outro.
      </p>
      <ul>
        <li>Quem transmite responde pelo que mostra. Compartilhe só o que você tem direito de mostrar.</li>
        <li>É proibido transmitir conteúdo sem os direitos necessários (filmes, séries, jogos ou eventos pagos de terceiros), conteúdo sexual, violência explícita, qualquer conteúdo envolvendo crianças ou adolescentes em situação sexual ou de risco, e dados pessoais de terceiros.</li>
        <li>Quem transmite ou o anfitrião pode fechar a entrada, remover uma pessoa da transmissão e encerrá-la. Qualquer espectador pode parar de assistir e denunciar a transmissão a qualquer momento.</li>
        <li>Uma violação pode levar ao encerramento da transmissão e da sala e ao bloqueio do acesso, e o início e o fim de cada transmissão ficam registrados, sem a imagem.</li>
      </ul>

      <h2>6. Moderação e remoção</h2>
      <p>
        O anfitrião de uma sala pode apagar mensagens e expulsar membros. Qualquer membro pode
        denunciar uma mensagem do chat pela função de denúncia da sala, e pode relatar membros ou
        salas ao contato indicado na seção 1. O operador pode
        remover conteúdo, encerrar salas e bloquear acessos que violem estes termos, a qualquer
        momento. Ações de moderação são registradas.
      </p>

      <h2>7. Serviços de terceiros</h2>
      <p>
        Spotify, YouTube e outros são serviços independentes. Sua relação com cada
        um é regida pelos termos e políticas deles, e o CoJam não os controla nem responde por
        eles. A reprodução de vídeo usa o player do YouTube no seu navegador.
      </p>

      <h2>8. Privacidade</h2>
      <p>
        O tratamento de dados pessoais está descrito na{' '}
        <a href="/privacidade">Política de Privacidade</a>.
      </p>

      <h2>9. Sem garantia</h2>
      <p>
        O CoJam é oferecido como está, sem garantia de disponibilidade, continuidade ou
        adequação a um fim específico. Salas e conversas são temporárias e podem desaparecer
        quando o servidor reinicia.
      </p>

      <h2>10. Mudanças</h2>
      <p>
        Estes termos podem mudar. A data no topo indica a última atualização, e o uso continuado
        após uma mudança significa que você a aceita.
      </p>

      <h2>11. Lei aplicável e foro</h2>
      <p>
        Lei brasileira. Foro: <code>[[FORO]]</code>.
      </p>
    </LegalPage>
  );
}
