import type { Metadata } from 'next';
import { LegalPage } from '@/app/components/LegalPage';
import { YourDataId } from '@/app/components/YourDataId';

export const metadata: Metadata = {
  title: 'Política de Privacidade',
  description:
    'Quais dados o CoJam trata, por quê, por quanto tempo, com quem são compartilhados e como exercer seus direitos pela LGPD.',
  alternates: { canonical: '/privacidade' },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Política de Privacidade"
      led={{ title: 'PRIVACIDADE', sub: 'SEUS DADOS' }}
      intro="O CoJam coordena salas de escuta compartilhada. Esta política descreve, com base no que o código faz hoje, quais dados pessoais são tratados, por quê, por quanto tempo e como você exerce seus direitos conforme a Lei Geral de Proteção de Dados (Lei 13.709/2018)."
    >
      <h2>1. Controlador e contato</h2>
      <ul>
        <li>Controlador: <code>[[CONTROLADOR: nome]]</code> (CNPJ/CPF: <code>[[CONTROLADOR: documento]]</code>)</li>
        <li>Encarregado (DPO) e canal de contato: <code>[[EMAIL DE CONTATO DPO]]</code></li>
      </ul>

      <h2>2. Estado atual do serviço</h2>
      <p>
        Hoje o CoJam funciona apenas com <strong>convidados</strong>: não é necessário criar conta
        e o login por conta está desativado. Se contas forem reativadas, esta política será
        atualizada na mesma mudança que as reativar.
      </p>
      <p>
        O CoJam transmite apenas <strong>metadados</strong> (título, artista, fila, votos).{' '}
        <strong>Nenhum áudio ou vídeo passa pelos servidores do CoJam</strong>: cada pessoa toca a
        música na própria conta, pelo SDK do próprio serviço.
      </p>

      <h2>3. Dados tratados, finalidade e base legal</h2>
      <table className="legal-table">
        <thead>
          <tr><th scope="col">Dado</th><th scope="col">Finalidade</th><th scope="col">Base legal (LGPD art. 7)</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Nome de exibição que você digita ao entrar, identificador de convidado (gerado e guardado no seu navegador) e token de conexão</td>
            <td>Identificar você na sala e atribuir faixas e votos</td>
            <td>Execução do serviço solicitado (V). <code>[[REVISAR: base]]</code></td>
          </tr>
          <tr>
            <td>Presença na sala (quem está conectado e desde quando), apenas em memória</td>
            <td>Mostrar quem está na sala e definir o anfitrião</td>
            <td>Execução do serviço (V)</td>
          </tr>
          <tr>
            <td>Fila (faixas e quem as adicionou), votos (ligados ao seu identificador), nome e visibilidade pública da sala</td>
            <td>Manter a fila compartilhada e a sala após reconexão</td>
            <td>Execução do serviço (V)</td>
          </tr>
          <tr>
            <td>Mensagens de chat</td>
            <td>Conversa entre membros da sala</td>
            <td>Execução do serviço (V). Não são gravadas em banco (seção 4).</td>
          </tr>
          <tr>
            <td>Denúncias: identificador do denunciante (quando disponível), sala, alvo, motivo e uma cópia do conteúdo denunciado (até 500 caracteres)</td>
            <td>Moderação e segurança, inclusive proteção de crianças e adolescentes</td>
            <td>Cumprimento de obrigação legal ou regulatória (II) e legítimo interesse (IX). <code>[[REVISAR: base]]</code></td>
          </tr>
          <tr>
            <td>Registro de ações de moderação (remoção de mensagem, expulsão): sala, quem agiu, alvo, data</td>
            <td>Trilha de auditoria de moderação</td>
            <td>Legítimo interesse (IX). <code>[[REVISAR: base]]</code></td>
          </tr>
          <tr>
            <td>Token de renovação do Spotify, se você conectar o Spotify</td>
            <td>Permitir que sua própria sessão toque no Spotify</td>
            <td>Consentimento (I), dado ao conectar</td>
          </tr>
          <tr>
            <td>Confirmação de idade mínima (somente o fato de ter confirmado, sem data de nascimento)</td>
            <td>Entrada em salas encontradas no diretório público</td>
            <td>Cumprimento de obrigação legal ou regulatória (II). <code>[[REVISAR: base]]</code></td>
          </tr>
          <tr>
            <td>
              Eventos de uso pseudonimizados: sala criada, entrada em sala, faixa iniciada, pulada ou
              curtida, busca (sem o texto), serviço conectado e pico de ouvintes por hora. Cada
              evento guarda a data, o nome do evento, identificadores embaralhados da sala e de quem
              agiu, e poucas informações genéricas (por exemplo, o serviço de música)
            </td>
            <td>Entender como o CoJam é usado e melhorar o produto</td>
            <td>Legítimo interesse (IX). <code>[[REVISAR: base]]</code></td>
          </tr>
          <tr>
            <td>Endereço IP e dados de conexão em registros técnicos do servidor e do provedor de rede</td>
            <td>Segurança, limite de abuso e operação</td>
            <td>Legítimo interesse (IX)</td>
          </tr>
        </tbody>
      </table>
      <p>
        O CoJam não coleta data de nascimento, documento, localização, nem dados sensíveis de
        propósito. O que você escrever livremente no chat ou no nome de exibição é de sua
        responsabilidade.
      </p>
      <p><strong>Eventos de uso: o que é e o que não é registrado</strong></p>
      <p>
        Os eventos de uso ficam em uma tabela do banco de dados do próprio CoJam. Os
        identificadores da sala e de quem agiu são embaralhados no servidor com uma chave que só o
        servidor conhece (HMAC-SHA256): quem consulta os painéis vê códigos que não revelam a sala
        nem a pessoa e que não dá para reverter sem essa chave. Como a mesma entrada sempre gera o
        mesmo código, o CoJam consegue contar quantas salas e pessoas diferentes houve, e por isso
        esses dados seguem sendo tratados como dados pessoais pseudonimizados.
      </p>
      <ul>
        <li>
          <strong>Registrado:</strong> que a sala foi criada ou alguém entrou nela; que uma faixa
          começou, foi pulada ou foi curtida, e por qual serviço de música; que uma busca
          aconteceu; que um serviço foi conectado; e o maior número de pessoas em uma sala em cada
          hora.
        </li>
        <li>
          <strong>Nunca registrado nesses eventos:</strong> endereço IP, nome de exibição, mensagens
          de chat, o texto das buscas, o título ou o artista das faixas, o código da sala em claro
          e o seu identificador de convidado em claro.
        </li>
      </ul>

      <h2>4. Retenção</h2>
      <ul>
        <li>
          <strong>Chat:</strong> existe somente na memória do servidor e some com a sala. Também
          é apagado quando o servidor é reiniciado (por exemplo, em uma atualização).
        </li>
        <li>
          <strong>Salas na memória:</strong> uma sala sem membros é removida da memória após 30
          minutos (<code>ROOM_IDLE_TTL_MINUTES</code>, padrão 30).
        </li>
        <li>
          <strong>Salas gravadas (fila e votos):</strong> uma sala sem nenhum membro conectado e
          sem alteração há 30 dias é excluída (<code>ROOM_PERSIST_IDLE_TTL_MINUTES</code>, 43200
          minutos em produção). O link da sala continua funcionando, mas a sala volta vazia.
        </li>
        <li>
          <strong>Token do Spotify:</strong> guardado criptografado no servidor e expira em 30
          dias, sendo apagado quando o Spotify o invalida.
        </li>
        <li>
          <strong>Denúncias e registros de moderação:</strong> hoje não há prazo de exclusão
          definido no código. <code>[[PRAZO DE RETENÇÃO DE DENÚNCIAS]]</code>
        </li>
        <li>
          <strong>Eventos de uso:</strong> 13 meses. Depois disso são apagados automaticamente,
          sem necessidade de pedido. Só são consultados em painéis agregados
          (contagens e médias), por uma conta de banco de dados somente leitura.
        </li>
        <li>
          <strong>Dados no seu navegador:</strong> ver seção 7. Você pode apagá-los quando quiser
          pelas configurações do navegador.
        </li>
      </ul>

      <h2>5. Com quem os dados são compartilhados</h2>
      <p>
        O CoJam não vende dados e não usa publicidade. Os serviços abaixo são os que o código
        realmente acessa.
      </p>
      <table className="legal-table">
        <thead>
          <tr><th scope="col">Terceiro</th><th scope="col">O que chega a ele</th><th scope="col">Onde</th></tr>
        </thead>
        <tbody>
          <tr><td>Spotify</td><td>Autorização (OAuth) e comandos de reprodução; buscas de faixas e importação de playlists</td><td>Seu navegador e o servidor</td></tr>
          <tr><td>YouTube / Google</td><td>Reprodução de vídeo e termos de busca ou IDs de vídeo para localizar faixas e importar playlists</td><td>Seu navegador e o servidor</td></tr>
          <tr><td>Deezer</td><td>Título, artista ou termos de busca; importação de playlists</td><td>Servidor</td></tr>
          <tr><td>MusicBrainz, ListenBrainz, Last.fm</td><td>Metadados da faixa (título, artista, ISRC) para enriquecimento e correspondência</td><td>Servidor</td></tr>
          <tr><td>Cloudflare</td><td>Todo o tráfego de acesso ao site, incluindo endereço IP, para TLS e túnel. <code>[[CONFIRMAR: uso de Cloudflare em produção]]</code></td><td>Rede</td></tr>
          <tr><td>Supabase</td><td>Identificadores de conta, somente se contas forem reativadas. Hoje desativado.</td><td>Não aplicável hoje</td></tr>
        </tbody>
      </table>
      <p>
        Esses serviços têm políticas próprias. Sua relação com o Spotify e o YouTube é
        regida pelos termos deles. Não há ferramentas de análise ou rastreamento de terceiros no
        CoJam: os eventos de uso (seção 3) ficam no banco de dados do próprio CoJam e nenhum
        fornecedor externo os recebe. Existe também uma telemetria do navegador,{' '}
        <strong>desativada por padrão</strong>; quando ligada, envia contagens de eventos e erros
        ao próprio servidor do CoJam.
      </p>

      <h2>6. Transferência internacional</h2>
      <p>
        Os serviços da seção 5 operam fora do Brasil. Local de hospedagem do CoJam:{' '}
        <code>[[LOCAL DE HOSPEDAGEM]]</code>. Salvaguardas aplicáveis (LGPD arts. 33 a 36):{' '}
        <code>[[REVISAR: mecanismo de transferência]]</code>.
      </p>

      <h2>7. Cookies e armazenamento no navegador</h2>
      <p>O CoJam não define cookies próprios. Usa o armazenamento do navegador para:</p>
      <ul>
        <li><strong>localStorage:</strong> identificador de convidado e token de conexão; confirmação de idade mínima; estado de login do Spotify.</li>
        <li><strong>sessionStorage:</strong> seu nome de exibição na sessão; seus votos por sala; dados temporários do fluxo de login do Spotify (PKCE).</li>
      </ul>
      <p>
        Esses itens são necessários ao funcionamento e não servem a publicidade. Os provedores
        embutidos (Spotify, YouTube) podem definir seus próprios cookies.
      </p>

      <h2>8. Seus direitos</h2>
      <p>
        Você pode pedir confirmação do tratamento, acesso, correção, anonimização, eliminação,
        portabilidade, informação sobre compartilhamento e revogação de consentimento (LGPD art.
        18), e peticionar à ANPD. Escreva para <code>[[EMAIL DE CONTATO DPO]]</code> informando o
        identificador de sala e o nome de exibição usado. Prazo de resposta:{' '}
        <code>[[PRAZO DE RESPOSTA]]</code>.
      </p>
      <p>
        Para pedir a exclusão, use o código da seção <a href="#excluir-seus-dados">Excluir seus dados</a>.
      </p>
      <p>
        <strong>Oposição aos eventos de uso.</strong> Como o tratamento dos eventos de uso se
        baseia em legítimo interesse, você pode se opor a ele (LGPD art. 18, §2º) escrevendo para{' '}
        <code>[[EMAIL DE CONTATO DPO]]</code>. Os eventos não guardam nome nem IP, então para
        localizar os seus precisamos do código da seção{' '}
        <a href="#excluir-seus-dados">Excluir seus dados</a>; sem ele não há como separar os seus
        eventos dos de outras pessoas. Com o código, o pedido segue o mesmo procedimento da
        exclusão: apagamos os eventos de uso já registrados com ele, junto com os demais dados
        ligados ao código. Em alguns casos os eventos são registrados por conexão, sem ligação com
        o seu código; esses não podem ser localizados e são apagados automaticamente após 13
        meses. Para que novos eventos não fiquem ligados ao mesmo código, apague os dados do site
        CoJam no seu navegador depois do pedido: um novo código será gerado.
      </p>
      <p>
        Como o serviço é de convidados, não podemos localizar dados sem esses indicadores. Parte
        dos dados (chat, presença) já não existe após o encerramento da sala. A remoção de
        atribuição e votos já gravados em uma sala e a exclusão do token do Spotify dependem de
        ação manual do operador; <code>[[CONFIRMAR: procedimento de atendimento de exclusão]]</code>.
      </p>

      <h2 id="excluir-seus-dados">Excluir seus dados</h2>
      <YourDataId inline />

      <h2>9. Crianças e adolescentes (ECA Digital)</h2>
      <ul>
        <li>Idade mínima para entrar em salas do diretório público: 16 anos, por autodeclaração. <code>[[REVISAR: idade mínima]]</code></li>
        <li>Salas encontradas por link de convite não passam por essa pergunta, e salas públicas têm chat ao vivo entre desconhecidos.</li>
        <li>Para denunciar uma mensagem do chat, use a função de denúncia na sala (disponível para convidados). Denúncias de membro ou sala podem ser enviadas ao contato da seção 1. Anfitriões podem apagar mensagens e expulsar membros.</li>
        <li>Responsáveis podem escrever para <code>[[EMAIL DE CONTATO DPO]]</code>.</li>
      </ul>

      <h2>10. Segurança</h2>
      <p>
        O token de renovação do Spotify é guardado cifrado (AES-GCM) no servidor e não é enviado
        ao navegador. Os endpoints públicos de denúncia e telemetria têm limite de taxa e de
        tamanho. Nenhum sistema é totalmente seguro.
      </p>

      <h2>11. Mudanças</h2>
      <p>
        Esta política pode mudar. A data no topo indica a última atualização, e o uso continuado
        após uma mudança indica ciência dela.
      </p>
    </LegalPage>
  );
}
