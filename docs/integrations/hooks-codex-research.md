AI Code CLI 자동 알림 설정 방법

AI 코딩 도구인 Claude Code CLI, Gemini CLI, OpenAI Codex CLI에서는 응답 완료나 사용자 입력 대기와 같은 이벤트를 자동 감지하여 알림을 보낼 수 있습니다. 각 CLI별로 출력 생성 방식과 해당 이벤트를 감지하는 방법(훅, 이벤트 리스너, stdout/파일 모니터링 등)을 살펴보고, 이를 이용해 데스크톱 알림, 소리 재생, Slack/Discord 메시지 등을 자동으로 보내는 구현 방법을 설명합니다. 필요한 경우 예시 코드와 스크립트를 함께 제공합니다.

Claude Code CLI에서의 이벤트 훅과 알림

Claude Code (Anthropic 제공) CLI는 내부적으로 Hook(훅) 시스템을 지원합니다. 훅은 Claude Code의 특정 라이프사이클 이벤트 발생 시 자동으로 지정한 동작을 수행할 수 있게 해주는 기능입니다
andrewford.co.nz
. Claude Code에서 제공하는 주요 훅 이벤트는 다음과 같습니다
andrewford.co.nz
:

PreToolUse: Claude가 어떤 툴을 사용하기 전에 발생 (예: 파일 편집 전에)

PostToolUse: 툴이 완료된 후 발생 (예: 툴 실행 성공 직후)

Notification: Claude가 사용자 주의가 필요할 때 발생 (권한 요청 등)

Stop: Claude가 응답을 모두 마쳤을 때 발생
andrewford.co.nz
 (메인 에이전트 응답 완료 시)

즉, Notification 훅은 Claude가 툴 실행에 대한 사용자 승인을 요구하거나, 입력 없이 일정 시간(idle 60초)이 경과해 주의가 필요한 상황에 호출됩니다
andrewford.co.nz
. Stop 훅은 Claude의 작업/응답이 완전히 끝났을 때 실행되어, 완료 이벤트를 감지할 수 있습니다
nakamasato.medium.com
.

Claude Code CLI에서는 /hooks 슬래시 명령어를 통해 인터랙티브하게 훅을 설정할 수 있고, 설정 파일 (~/.claude/settings.json 등)에 훅을 정의할 수도 있습니다. 훅은 임의의 쉘 명령을 실행할 수 있으므로, 이를 이용해 OS 알림이나 웹 요청을 발생시키면 됩니다
andrewford.co.nz
andrewford.co.nz
.

예를 들어, 응답 완료 시 데스크톱 알림을 보내는 훅과, 사용자 입력이 필요할 때 슬랙으로 메시지를 보내는 훅을 설정해보겠습니다. 아래는 .claude/settings.json에 훅을 정의하는 예시입니다:

{
  "hooks": {
    "Stop": [
      {
        "matcher": "",  // 특정 툴 패턴 매칭 (없으면 항상 실행)
        "hooks": [
          {
            "type": "command",
            "command": "if command -v osascript >/dev/null 2>&1; then osascript -e 'display notification \"Claude Code 작업이 완료되었습니다\" with title \"✅ Claude Code Done\"'; elif command -v notify-send >/dev/null 2>&1; then notify-send '✅ Claude Code' '작업이 완료되었습니다'; fi"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "curl -X POST -H 'Content-type: application/json' --data '{\"text\":\"⚠️ Claude: 승인 또는 입력이 필요합니다.\"}' https://hooks.slack.com/services/＜YOUR_SLACK_WEBHOOK_URL＞"
          }
        ]
      }
    ]
  }
}


Stop 훅: 위 command는 Mac의 osascript(알림 센터 배너) 또는 Linux의 notify-send를 통해 데스크톱 알림을 띄웁니다
reddit.com
. 작업 완료를 알려주는 메시지를 ✅ Claude Code Done 제목으로 표시합니다. 필요에 따라 afplay(맥)나 paplay(리눅스)를 호출해 소리를 재생하도록 추가할 수도 있습니다. 예를 들어 osascript로 알림을 띄우면서 afplay /System/Library/Sounds/Glass.aiff 등을 실행하면 맥에서 소리도 재생됩니다.

Notification 훅: 위 예시에서는 Slack Incoming Webhook URL을 통해 Slack 채널에 경고 이모지와 함께 *"Claude: 승인 또는 입력이 필요합니다."*라는 메시지를 보내도록 설정했습니다. curl로 간단히 POST 요청을 보내 Slack 알림을 발생시킵니다. Discord의 웹훅도 비슷하게 https://discord.com/api/webhooks/... URL로 JSON payload를 POST하면 됩니다. (실제 사용 시에는 ＜YOUR_SLACK_WEBHOOK_URL＞ 부분에 본인의 웹훅 URL을 넣으세요.)

위 설정을 적용하고 Claude Code CLI를 실행하면, Claude가 코드 변경 권한을 물어보는 등의 사용자 입력 대기 상황에서 Notification 훅이 발동되어 Slack으로 알림을 보내고, 모든 작업이 완료되어 대기 상태가 될 때 Stop 훅이 발동되어 데스크톱 알림(및 소리)이 울리게 됩니다. 이러한 훅 설정은 Claude Code의 행동을 결정론적으로 제어할 수 있게 해주며, 백그라운드로 Claude를 실행하면서도 놓치지 않고 상황을 파악할 수 있도록 돕습니다
andrewford.co.nz
andrewford.co.nz
.

참고 자료: Claude Code 훅 시스템에 대한 공식 문서와 활용 예제가 다수 존재합니다. 예를 들어, Andrew Ford의 블로그에서는 ntfy 서비스를 활용해 Claude의 Notification 훅으로 푸시 알림을 보내는 예제를 소개합니다
andrewford.co.nz
. 위 설정에서 ntfy를 쓰는 경우 훅 커맨드에 curl -d "Claude needs your attention" ntfy.sh/<토픽> 형태로 넣고, 휴대폰에 ntfy 앱을 설치해 해당 토픽을 구독하면 Claude가 승인 대기 시 즉시 푸시를 받을 수 있습니다
andrewford.co.nz
andrewford.co.nz
. Reddit의 한 예시에서는 Stop 훅에 OS 알림을, Notification 훅에 비프음을 넣어 Claude가 백그라운드에서 돌아갈 때 영상을 보다가도 멈추지 않도록 활용했다고 합니다
reddit.com
. Claude Code 훅은 이처럼 자유도가 높으므로, 원하는 스크립트나 프로그램을 연결해 Slack/Discord 메시지 전송, 특정 사운드 재생, 심지어 스마트폰 알림 전송까지 자동화할 수 있습니다.

Gemini CLI에서의 이벤트 감지와 알림 자동화

Gemini CLI (Google Gemini) 역시 터미널 기반 AI 코딩 에이전트로, Claude Code와 유사한 기능을 지향합니다. Gemini CLI는 현재 (2025년 말 시점) 훅 시스템이 개발 중이며, 실험적으로 제공되는 버전에서는 훅을 활성화할 수 있습니다
geminicli.com
. ~/.gemini/settings.json 설정에서 tools.enableHooks = true로 활성화하면, 정해진 라이프사이클 이벤트에서 훅 스크립트를 실행할 수 있는 구조를 가지고 있습니다
geminicli.com
. Gemini CLI의 훅 이벤트는 Claude와 개념적으로 유사하게 설계되고 있으며, BeforeTool, AfterTool, BeforeAgent, AfterAgent, Notification, SessionStart/End 등 다양한 이벤트를 지원하도록 논의되었습니다
github.com
. 특히 Notification 이벤트와 Stop/AfterAgent 이벤트를 이용해 우리가 원하는 알림 시점을 잡을 수 있습니다. (Notification은 Claude와 마찬가지로 “사용자 입력/승인 필요” 상황, Stop/AfterAgent는 작업 완료 시점을 나타냅니다.)

주의: Gemini CLI의 훅 기능은 아직 정식 릴리스에 완전히 반영되지 않았거나, 기본값으로 꺼져 있을 수 있습니다
geminicli.com
github.com
. 공식 로드맵상 이 기능이 요청되어 있으며 적극 개발되고 있습니다
github.com
github.com
. 예를 들어, Gemini CLI 팀은 Claude Code와의 기능 패리티를 위해 다음과 같은 훅 설정을 제안한 바 있습니다
github.com
:

{
  "hooks": {
    "preToolUse": "./hooks/before-tool.sh",
    "postToolUse": "./hooks/after-tool.sh",
    "notification": "./hooks/notify.sh",
    "stop": "./hooks/cleanup.sh"
  }
}


위에서 보듯 Notification 시 특정 스크립트(notify.sh)를, stop 시 클린업/알림 스크립트(cleanup.sh)를 실행하도록 지정할 수 있습니다
github.com
. 실제 Gemini CLI의 훅 설정 문법은 Claude Code와 거의 같으며 (Claude의 설정을 가져와 .gemini에 변환해주는 이행 도구도 논의되고 있습니다
github.com
), JSON 형식 설정 파일에서 경로 또는 명령어를 지정하는 방식입니다.

따라서 Gemini CLI에서 자동 알림을 구현하는 방법도 Claude와 비슷합니다:

Hooks 활용 (실험적): ~/.gemini/settings.json에 Notification 훅과 Stop (혹은 AfterAgent) 훅을 정의하고, 각각 Slack/Discord 웹훅이나 notify-send 등의 명령을 실행하도록 설정합니다. 예를 들면 Claude의 예시와 유사하게 "command": "notify-send 'Gemini CLI' '작업 완료'" 또는 Slack 웹훅 curl 명령을 넣을 수 있습니다. 훅을 활성화한 상태에서 Gemini CLI를 구동하면, Claude 때와 마찬가지로 백그라운드 작업 완료 시 데스크톱 알림을 띄우거나, 사용자 입력이 필요할 때 Slack/Discord 메시지로 알려주는 자동화가 가능합니다.

대안적 방법: 만약 훅 시스템을 사용할 수 없는 환경이라면, 출력 모니터링을 통한 방법을 고려해볼 수 있습니다. Gemini CLI는 터미널 UI에 진행 상황과 승인 요청 등을 출력하므로, 이를 감지하는 스크립트를 작성할 수 있습니다. 예를 들어 파이썬의 pexpect 라이브러리나 UNIX expect 스크립트를 이용해 gemini 프로세스를 실행하고, 표준 출력에서 "Confirm"이나 "Allow (y/N)" 등의 패턴을 실시간으로 파싱하여 감지하는 방법입니다. 또한 Gemini CLI는 세션 로그/기록을 .gemini/tmp/ 이하에 JSON 또는 로그 파일로 남길 수 있으므로
github.com
, 이 파일 변화를 inotifywait 등으로 감시해 이벤트를 추론하는 방법도 생각해볼 수 있습니다. 그러나 이러한 커스텀 파싱은 다소 복잡하므로, 가능하다면 공식 제공 훅이나 내장 알림 기능을 활용하는 편이 좋습니다. (Gemini CLI에도 향후 /notifications라는 내장 슬래시 명령으로 소리 알림 등을 설정하는 기능이 제안되어 있습니다
github.com
github.com
.)

결론: Gemini CLI에서는 곧 Claude Code와 동일한 훅 기반 자동화가 가능해질 전망이며, 이를 통해 작업 완료음, 데스크톱 알림, Slack/Discord 메시지 전송을 쉽게 구현할 수 있습니다. 현재는 experimental이지만 tools.enableHooks 옵션과 설정 파일을 통해 Notification/Stop 이벤트에 대한 훅을 걸어 둘 수 있으며, 이러한 훅은 MessageBus와 연계되어 내부 이벤트 발생 시 여러분의 스크립트를 호출해줄 것입니다
geminicli.com
. 커뮤니티에서도 Gemini에 Claude와 같은 알림 기능이 꼭 필요하다는 요구가 많으므로
github.com
, 최신 버전을 주시하시기 바랍니다.

OpenAI Codex CLI에서의 이벤트 감지와 알림

Codex CLI는 OpenAI가 2025년에 공개한 오픈소스 터미널 코딩 비서로, 이 역시 터미널 UI에서 동작하며 여러 작업을 자동화합니다
medium.com
. Codex CLI는 내장된 이벤트 알림 기능을 지원하는데, 설정 파일(~/.codex/config.toml)에 notify 옵션을 지정하면 Codex가 특정 이벤트마다 외부 프로그램(예: 스크립트)을 자동 호출합니다
developers.openai.com
. 이 기능은 Codex CLI가 응답 생성을 마치고 다시 사용자 입력을 기다릴 때 (agent-turn-complete 이벤트) 트리거됩니다
developers.openai.com
. 즉, 한 턴의 작업이 완료되어 사용자에게 제어가 돌아올 때마다 Codex가 우리가 지정한 명령을 실행해 주는 것입니다.

Codex의 notify 설정 형식은 매우 간단합니다. ~/.codex/config.toml에 다음과 같이 입력합니다
kanman.de
:

notify = ["python3", "/path/to/notify_script.py"]


위처럼 설정하면, Codex는 매 이벤트 발생 시 python3 /path/to/notify_script.py '<이벤트 JSON 페이로드>' 형태로 JSON 데이터를 인자로 넘겨 우리 스크립트를 실행합니다
kanman.de
. Codex가 전달하는 JSON에는 이벤트 종류(type), 마지막으로 생성된 assistant 메시지, 그리고 해당 턴의 사용자 명령 목록 등이 포함됩니다
kanman.de
. 예를 들어 이벤트 type이 "agent-turn-complete"이면 Codex가 마지막 답변을 마치고 사용자 입력을 기다리는 상태임을 나타냅니다
kanman.de
kanman.de
. (추후 승인 대기나 오류 등의 이벤트 타입이 추가될 수 있지만, 현재는 주로 agent-turn-complete이 사용됩니다.)

notify 스크립트 구현: notify_script.py에서는 전달된 JSON 문자열을 파싱하여 원하는 액션을 수행하면 됩니다. OpenAI 공식 문서에서는 macOS에서 터미널 알림을 띄우는 파이썬 예시를 보여주고 있습니다
developers.openai.com
:

#!/usr/bin/env python3
import json, subprocess, sys

data = json.loads(sys.argv[1])
if data.get("type") != "agent-turn-complete":
    sys.exit(0)  # 다른 이벤트는 무시
# 예: 마지막 답변 메시지 내용과 사용자 요청을 조합하여 알림 제목/내용 구성
title = "Codex: " + data.get("last-assistant-message", "작업 완료")
message = "요청: " + " / ".join(data.get("input-messages", []))
# macOS notification (terminal-notifier 사용)
subprocess.run([
    "terminal-notifier",
    "-title", title,
    "-message", message,
    "-group", "codex-"+ data.get("thread-id", ""),
    "-activate", "com.googlecode.iterm2"
])


위 스크립트는 인자로 받은 JSON을 파싱한 뒤, 이벤트 타입이 agent-turn-complete인 경우에만 진행합니다
developers.openai.com
. 그런 다음 알림 제목과 메시지 내용을 구성하고, macOS의 terminal-notifier 툴을 호출하여 알림을 띄웁니다
developers.openai.com
. (terminal-notifier는 맥용 CLI 알림 도구이고, Linux에서는 notify-send로 대체 가능합니다. Windows의 경우 파이썬에서 Win10 토스트 알림을 띄우려면 winsdk나 win10toast 라이브러리를 사용할 수 있습니다.)

Slack/Discord 연동: Codex의 notify 스크립트에서도 Slack이나 Discord로 메시지를 보낼 수 있습니다. 앞서 Claude/Gemini와 마찬가지로, 파이썬 스크립트 안에서 requests 등을 사용해 Slack 웹훅 URL에 POST를 보내거나, subprocess.run(["curl", ...])로 웹훅을 호출하면 됩니다. 예를 들어 위 코드에서 terminal-notifier 대신:

# Slack 웹훅으로 POST 보내기 예시
webhook_url = "https://hooks.slack.com/services/XXX/YYY/ZZZ"
payload = {"text": f"Codex: 작업 완료 - {data.get('last-assistant-message', '').strip()}"}
subprocess.run(["curl", "-X", "POST", "-H", "Content-type: application/json",
                "--data", json.dumps(payload), webhook_url])


이런 식으로 Slack에 알림을 보낼 수 있습니다. Discord의 경우 payload의 키가 "content"여야 하고 URL이 discord 웹훅 URL로 바뀌는 것만 제외하면 방식은 동일합니다.

Codex CLI의 notify 기능을 요약하면, Codex에서 지원하는 이벤트 발생 시 (현재는 작업 턴 완료 시) 자동으로 외부 프로그램을 호출하여 알림을 보낼 수 있다는 것입니다
developers.openai.com
. 이를 이용해 CI 파이프라인 상태 보고, 채팅봇에 진행 상황 전송, 데스크톱 토스트 알림, 사운드 재생 등 다양한 작업을 연동할 수 있습니다
developers.openai.com
. 예컨대 어떤 분은 Codex로 긴 리팩토링을 돌려놓고 YouTube를 보다가, Codex가 끝나면 notify 스크립트를 통해 윈도우 알림과 시스템 비프음을 울리도록 세팅해 둔 사례도 있습니다 (Codex 깃허브 이슈에 관련 요청이 있었고, 공식 기능으로 터미널 UI 내 알림도 제공됩니다)
github.com
.

Tip: Codex CLI 자체에도 TUI 상단에 작은 완료 알림을 띄우는 옵션(tui.notifications)이 있지만
developers.openai.com
, 외부 채널로 알림을 보내고 싶다면 notify 설정이 훨씬 강력합니다. 또한 Codex는 매 턴 완료마다 이벤트를 보내주므로, 여러 단계의 작업에서도 각 단계 종료 시점에 꾸준히 알림을 받을 수 있습니다
kanman.de
kanman.de
. 이를 응용하면 *“코드 생성 -> 테스트 실행 -> 오류 수정”*과 같은 반복 작업의 각 사이클 완료 시 알림을 받고 개입하는 자동화도 가능합니다.

정리 및 추가 고려사항

세 가지 CLI 모두 이벤트 훅/알림 시스템을 활용하여 백그라운드 작업 시 사용자에게 즉각적인 피드백을 주는 설정이 가능합니다. Claude Code CLI는 성숙한 훅 시스템으로 Stop/Notification 훅을 제공하며
andrewford.co.nz
, Gemini CLI도 유사 기능을 도입 중입니다. Codex CLI는 notify 설정을 통한 이벤트 알림 호출을 기본 제공하여 손쉽게 스크립트를 연계할 수 있습니다
developers.openai.com
.

데스크톱 알림은 OS별 커맨드를 사용하거나 전용 패키지(terminal-notifier, notify-send 등)를 이용해 구현하고, 소리 알림은 OS 커맨드 (afplay, paplay, PowerShell -c (SoundPlayer) 등)이나 단순 터미널 벨(echo -e "\a")로도 가능합니다. Slack/Discord 등의 푸시는 각 서비스의 Incoming Webhook URL을 이용해 curl/HTTP POST를 보내는 방식으로 쉽게 통합됩니다. 중요한 점은, 이러한 통합을 CLI 내부의 이벤트와 정확히 연동하는 것이며, 소개된 훅/notify 메커니즘이 그 역할을 합니다.

마지막으로, 훅이나 notify 스크립트를 작성할 때 이벤트 정보를 파싱하여 어떤 알림을 보낼지 커스터마이즈할 수 있습니다. 예를 들어 Claude의 Stop 훅에서는 최근 assistant 메시지 요약을 읽어와 알림에 표시하거나
nakamasato.medium.com
nakamasato.medium.com
, Codex의 JSON 페이로드를 파싱해 다음에 해야 할 액션을 미리 알려주는 등 다양한 활용이 가능합니다. 다만 처음에는 단순히 “완료” 또는 “승인 필요”와 같은 내용만 보내는 것으로 시작해도 충분히 유용합니다.

以上のように 구성하면, 터미널에서 AI 코딩 에이전트를 돌려놓고 다른 작업을 하다가도 결과 출력이나 확인 요청을 놓치지 않고 바로 대응할 수 있습니다. 이는 개발 워크플로우의 효율을 높이고, 기다리는 시간을 줄여줄 것입니다. 필요한 설정을 적용한 후 꼭 테스트를 통해 제대로 동작하는지 확인하시기 바랍니다 (예: 의도적으로 작은 작업을 시켜서 알림이 오는지 검증). 각 CLI의 공식 문서와 커뮤니티 리소스를 참고하면 최신 훅/알림 기능의 사용 방법과 팁을 추가로 얻을 수 있습니다
andrewford.co.nz
github.com
.