에이전트 워크플로우 오케스트레이션: Claude Code 및 Gemini CLI를 위한 후크(Hook) 아키텍처 및 알림 시스템 구축 가이드1. 서론: 이벤트 기반 AI 개발 환경의 도래소프트웨어 개발의 패러다임은 인간이 직접 코드를 작성하는 단계에서, AI 에이전트를 조율하고 관리하는 '에이전트 오케스트레이션(Agentic Orchestration)' 단계로 급격히 이동하고 있습니다. 이러한 변화의 중심에는 Anthropic의 Claude Code와 Google의 Gemini CLI와 같은 강력한 터미널 기반 AI 도구들이 존재합니다. 그러나 이 도구들을 단순한 챗봇 인터페이스로 사용하는 것은 그 잠재력의 극히 일부만을 활용하는 것입니다. 진정한 생산성의 혁신은 개발자의 로컬 환경과 AI 에이전트 간의 긴밀한 통합, 즉 이벤트 기반(Event-Driven) 상호작용을 통해 달성됩니다.본 보고서는 개발자가 AI 에이전트의 인지 루프(Cognitive Loop) 내에 개입할 수 있는 유일한 메커니즘인 후크(Hook) 시스템과, 비동기적인 에이전트 작업 흐름을 끊김 없이 관리하기 위한 알림(Notification) 아키텍처에 대해 심층적으로 분석합니다. 특히 Codex CLI를 제외하고, 현재 가장 실무 적용 가능성이 높은 Claude Code의 네이티브 후크 시스템과 Gemini CLI의 스트림 기반 래퍼(Wrapper) 패턴을 중심으로, 엔터프라이즈 수준의 워크플로우를 구축하기 위한 기술적 세부 사항을 총망라합니다. 단순한 명령어 나열을 넘어, 각 도구의 내부 동작 원리, 데이터 페이로드(Payload) 구조, 그리고 운영체제(macOS, Linux, Windows) 별 최적화된 구현 전략을 포함하여 약 15,000단어 분량의 심층 가이드를 제공합니다.2. 이론적 배경: 에이전트 라이프사이클과 인터셉션(Interception) 모델코딩 에이전트를 효과적으로 제어하기 위해서는 먼저 에이전트가 코드를 생성하고 실행하는 내부 주기를 이해해야 합니다. 에이전트의 작업은 단일 요청-응답이 아닌, 연속적인 상태 전이(State Transition)의 과정입니다. 후크(Hook)는 이 상태 전이의 틈새에 개발자가 정의한 로직을 주입하는 기술적 인터페이스입니다.2.1 OODA 루프와 개입 시점AI 에이전트는 일반적으로 **관찰(Observe) → 판단(Orient) → 결정(Decide) → 행동(Act)**의 OODA 루프를 따릅니다. 개발자가 개입할 수 있는 시점은 크게 세 가지로 분류됩니다.사전 실행(Pre-Action) 단계: 에이전트가 특정 도구(예: 파일 쓰기, 터미널 명령어 실행)를 사용하기로 '결정'했으나, 아직 '행동'하지 않은 시점입니다. 이 시점의 후크는 보안 게이트(Security Gate) 역할을 수행합니다. 예를 들어, rm -rf와 같은 파괴적인 명령어를 차단하거나, 프로덕션 데이터베이스에 대한 접근을 승인하는 절차가 여기서 이루어집니다.3사후 실행(Post-Action) 단계: 에이전트가 도구 사용을 완료하고 결과를 반환받은 직후입니다. 이 시점의 후크는 품질 보증(QA) 및 정리(Cleanup) 역할을 수행합니다. 생성된 코드에 대해 린터(Linter)를 실행하거나, 성공적인 파일 변경 내역을 Git에 자동으로 커밋(Checkpointing)하는 작업이 해당됩니다.5대기 상태(Idle/Notification) 단계: 에이전트가 작업을 마치고 사용자의 입력을 기다리거나, 권한 승인을 요청하는 시점입니다. 이는 **사용자 환기(Re-engagement)**를 위한 알림 시스템의 트리거가 됩니다. 긴 빌드 프로세스나 복잡한 리팩토링 작업을 에이전트에게 위임한 경우, 이 알림은 개발자의 멀티태스킹 효율을 결정짓는 핵심 요소입니다.62.2 네이티브 후크 vs. 합성 후크도구의 아키텍처에 따라 후크를 구현하는 방식은 근본적으로 다릅니다.네이티브 후크(Native Hooks): Claude Code는 설정 파일(settings.json)을 통해 공식적으로 후크를 지원합니다. 도구 자체가 이벤트 발생 시 지정된 스크립트를 실행하고, 표준 입력(stdin)을 통해 컨텍스트를 전달하며, 종료 코드(exit code)를 통해 제어 흐름을 관리합니다.7합성 후크(Synthetic Hooks): Gemini CLI와 같이 명시적인 후크 설정이 없는 경우, 개발자는 도구의 출력을 실시간으로 파싱하여 이벤트를 감지하는 래퍼(Wrapper) 프로그램을 작성해야 합니다. 이는 스트림 처리(Stream Processing) 기술을 요구하며 구현 복잡도가 높지만, 더 유연한 제어가 가능합니다.83. Claude Code: 네이티브 후크 시스템의 심층 분석 및 구현Claude Code는 현재 시장에 나와 있는 AI 코딩 도구 중 가장 성숙한 후크 시스템을 제공합니다. 이 시스템은 계층화된 설정 파일과 명확한 이벤트 분류, 그리고 JSON 기반의 통신 프로토콜을 특징으로 합니다.3.1 설정 파일의 계층 구조와 범위 관리Claude Code의 설정은 단일 파일이 아닌, 우선순위를 가진 계층 구조로 관리됩니다. 이는 팀 단위의 정책과 개인별 선호도를 충돌 없이 공존하게 만드는 핵심 설계입니다.우선순위파일 경로범위용도 및 권장 사항1 (최상위).claude/settings.local.json로컬 프로젝트개인적인 디버깅용 후크나 로컬 경로 설정에 사용합니다. .gitignore에 반드시 포함시켜 팀원 간 설정 충돌을 방지해야 합니다.2.claude/settings.json프로젝트 공유팀 전체에 강제할 린팅 규칙, 테스트 자동화, 보안 정책을 정의합니다. Git에 커밋하여 모든 팀원이 동일한 에이전트 행동 양식을 갖도록 합니다.3 (최하위)~/.claude/settings.json전역 사용자모든 프로젝트에 적용될 개인별 알림 설정(예: 소리 알림, 데스크톱 푸시)을 정의합니다. 1심층 분석: 이러한 계층 구조는 '설정의 상속(Configuration Inheritance)'을 의미합니다. 전역 설정에서 알림 훅을 정의하고, 프로젝트 설정에서 린팅 훅을 정의하면, 실제 실행 시에는 두 후크가 모두 병합되어 작동합니다. 만약 동일한 이벤트(예: PreToolUse)에 대해 전역 설정과 프로젝트 설정이 충돌할 경우, 더 구체적인 범위(로컬 > 프로젝트 > 전역)의 설정이 우선하거나 병합됩니다. 따라서 settings.local.json은 특정 프로젝트에서 에이전트의 행동을 일시적으로 변경(예: 리팩토링 중 린팅 끄기)할 때 유용합니다.3.2 후크 이벤트 상세 명세 및 페이로드 분석각 후크 이벤트는 실행 시점에 따라 고유한 데이터 페이로드(Payload)를 스크립트의 표준 입력(stdin)으로 전달합니다. 이 데이터를 파싱하고 활용하는 것이 고급 후크 작성의 핵심입니다.3.2.1 PreToolUse (도구 사용 전 인터셉션)이 후크는 에이전트가 도구를 실행하기 직전에 트리거됩니다. 가장 강력한 권한을 가지며, 에이전트의 행동을 거부하거나 수정할 수 있습니다.트리거 시점: LLM이 도구 호출(Tool Call)을 생성하고, 런타임이 이를 실행하려는 찰나.제어 방식: 스크립트의 종료 코드(Exit Code)를 사용합니다.0: 승인 (실행 진행).1: 오류 (에이전트에게 오류 메시지 반환).2: 차단 (사용자에게 경고를 표시하고 실행 중단).10JSON 페이로드 구조 (예시):JSON{
  "type": "PreToolUse",
  "tool": "Bash",
  "args": {
    "command": "rm -rf./node_modules"
  },
  "session_id": "sess_12345",
  "project_path": "/Users/dev/project"
}
3.2.2 PostToolUse (도구 사용 후 처리)도구 실행이 완료된 후, 그 결과를 에이전트의 컨텍스트(Context)에 추가하기 전에 실행됩니다.트리거 시점: 도구 실행 프로세스가 종료된 직후.용도: 결과 검증, 자동 포맷팅, 로깅.JSON 페이로드 구조 (예시):JSON{
  "type": "PostToolUse",
  "tool": "Write",
  "args": { "path": "src/app.ts" },
  "result": {
    "stdout": "File written successfully.",
    "stderr": "",
    "exit_code": 0
  }
}
3.2.3 Notification (상태 알림)에이전트가 자율적인 작업을 멈추고 인간의 개입을 필요로 할 때 발생합니다.트리거 시점: permission_request (권한 요청) 또는 waiting_for_input (입력 대기) 상태 진입 시.용도: 시청각 알림, 외부 메신저 연동.JSON 페이로드 구조 (예시):JSON{
  "type": "Notification",
  "message": "Claude needs your permission to run 'npm install'.",
  "level": "info"
}
3.3 실전 구현 가이드: Python을 활용한 고급 보안 필터 (PreToolUse)단순한 쉘 스크립트로는 복잡한 JSON 파싱과 정규표현식 처리가 어렵습니다. Python을 사용하여 강력한 보안 필터링 후크를 구현해 보겠습니다. 이 스크립트는 에이전트가 시스템에 치명적인 명령어를 실행하는 것을 방지합니다.구현 목표:Bash 도구 호출만 선별적으로 검사합니다.금지된 명령어 패턴(예: 루트 디렉토리 삭제, 포맷팅, 시스템 설정 변경)을 탐지합니다.탐지 시 실행을 차단하고 사용자에게 경고를 출력합니다.스크립트 위치: ~/.claude/hooks/security_guard.pyPython#!/usr/bin/env python3
import sys
import json
import re

# 1. 차단할 위험한 명령어 패턴 정의
# 정규표현식을 사용하여 변형된 명령어까지 포착합니다.
DANGEROUS_PATTERNS =+\s+/",           # 루트 디렉토리 재귀 삭제 시도
    r"mkfs",                       # 파일시스템 포맷
    r"dd\s+if=",                   # 저수준 데이터 복사 (디스크 덮어쓰기 위험)
    r">:.*(?:/etc/|/boot/|/var/)", # 시스템 중요 디렉토리에 덮어쓰기
    r"chmod\s+777",                # 과도한 권한 부여
    r"wget\s+.*\|\s*bash",         # 인터넷에서 스크립트 받아 바로 실행 (파이핑)
    r"curl\s+.*\|\s*bash"
]

def log_alert(message):
    """표준 에러(stderr)로 경고 메시지를 출력합니다. 이는 Claude Code UI에 붉게 표시됩니다."""
    print(f"\n 🚨 BLOCKED: {message}", file=sys.stderr)

def main():
    try:
        # 2. 표준 입력(stdin)으로부터 페이로드 읽기
        # Claude Code는 이벤트 데이터를 JSON 문자열로 파이핑합니다.
        raw_input = sys.stdin.read()
        if not raw_input:
            sys.exit(0)
        
        payload = json.loads(raw_input)
        
        # 3. 도구 유형 확인
        # Bash 명령어가 아닌 경우(예: 파일 읽기/쓰기)는 검사하지 않고 통과시킵니다.
        if payload.get("tool")!= "Bash":
            sys.exit(0)
            
        # 명령어 추출 (Bash 도구의 인자 구조에 따라 접근)
        command = payload.get("args", {}).get("command", "")
        
        # 4. 패턴 매칭 검사
        for pattern in DANGEROUS_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                log_alert(f"Detected prohibited command pattern: '{pattern}'")
                log_alert(f"Command Attempted: {command}")
                # 종료 코드 2는 실행을 '차단'하라는 신호입니다.
                sys.exit(2)
                
        # 5. 안전한 경우 통과
        sys.exit(0)

    except json.JSONDecodeError:
        # JSON 파싱 실패 시, 안전을 위해 차단하거나 로그를 남기고 통과시킬 수 있습니다.
        # 여기서는 통과시키되 로그를 남깁니다.
        print(" ⚠️ Failed to parse hook payload.", file=sys.stderr)
        sys.exit(0)
    except Exception as e:
        print(f" ⚠️ Unexpected error: {e}", file=sys.stderr)
        sys.exit(0)

if __name__ == "__main__":
    main()
설정 파일 (~/.claude/settings.json) 적용:JSON{
  "hooks": {
    "PreToolUse":
      }
    ]
  }
}
코드 분석 및 확장 포인트:JSON 파싱: sys.stdin.read()를 통해 에이전트가 보내는 모든 컨텍스트 데이터를 읽어옵니다. 이는 도구의 인자뿐만 아니라 세션 ID 등을 포함하므로, 로깅 목적으로 데이터베이스에 저장할 수도 있습니다.re.IGNORECASE: 에이전트가 대소문자를 섞어 쓰더라도(Rm -Rf) 탐지할 수 있도록 플래그를 설정했습니다.종료 코드 2: 단순 실패(1)가 아닌 명시적 차단(2)을 사용함으로써 에이전트에게 "이 명령은 정책상 불가능하다"는 피드백을 줄 수 있습니다.103.4 실전 구현 가이드: 자동 포맷팅 및 Linting (PostToolUse)에이전트가 작성한 코드는 기능적으로 올바를 수 있지만, 팀의 스타일 가이드를 따르지 않을 수 있습니다. PostToolUse 훅을 사용하여 파일이 작성될 때마다 자동으로 포맷터(Formatter)를 실행하면 코드 리뷰 시간을 단축할 수 있습니다.구현 목표:Write 또는 Edit 도구가 성공적으로 실행된 경우에만 트리거.수정된 파일의 확장자를 감지하여 적절한 도구(Black, Prettier, GoFmt 등) 실행.오류 발생 시 에이전트의 흐름을 방해하지 않도록 처리.스크립트 위치: ~/.claude/hooks/auto_formatter.shBash#!/bin/bash

# stdin에서 JSON 페이로드 읽기
payload=$(cat)

# jq를 사용하여 수정된 파일의 경로 추출
# 'Write' 도구는 args.path에 파일 경로를 포함합니다.
file_path=$(echo "$payload" | jq -r '.args.path')

# 파일이 실제로 존재하는지 확인
if [! -f "$file_path" ]; then
    exit 0
fi

# 확장자 추출
extension="${file_path##*.}"

# 포맷팅 로직
# 에러 출력(stderr)은 /dev/null로 보내거나 로깅 파일로 리다이렉트하여
# 에이전트의 컨텍스트를 오염시키지 않도록 주의합니다.
case "$extension" in
    py)
        if command -v black &> /dev/null; then
            black "$file_path" > /dev/null 2>&1
        elif command -v autopep8 &> /dev/null; then
            autopep8 --in-place "$file_path" > /dev/null 2>&1
        fi
        ;;
    js|ts|jsx|tsx|json|css|md)
        if command -v prettier &> /dev/null; then
            prettier --write "$file_path" > /dev/null 2>&1
        fi
        ;;
    go)
        if command -v gofmt &> /dev/null; then
            gofmt -w "$file_path" > /dev/null 2>&1
        fi
        ;;
    rs)
        if command -v rustfmt &> /dev/null; then
            rustfmt "$file_path" > /dev/null 2>&1
        fi
        ;;
esac

# 포맷팅이 실패하더라도 에이전트 작업은 성공으로 간주해야 하므로 항상 0 반환
exit 0
설정 파일 (.claude/settings.json) 적용:이 설정은 프로젝트 단위로 적용하는 것이 좋습니다.JSON{
  "hooks": {
    "PostToolUse":
      }
    ]
  }
}
인사이트: 이 방식은 "에이전트가 코드를 포맷팅하도록 요청"하는 것보다 훨씬 효율적입니다. 토큰 비용을 절약할 뿐만 아니라, 에이전트가 포맷팅 과정에서 코드를 잘못 수정(Hallucination)할 위험을 원천 차단합니다.54. Gemini CLI: 스트림 기반 래퍼(Wrapper) 아키텍처 구축Gemini CLI는 2024년 말 기준으로 settings.json을 통한 네이티브 후크 시스템을 제공하지 않습니다. 그러나 --output-format stream-json 옵션을 통해 에이전트의 내부 상태와 출력을 실시간 스트림 데이터로 방출하는 기능을 제공합니다. 이를 활용하여 우리는 Gemini CLI를 감싸는 래퍼(Wrapper) 프로그램을 작성함으로써 가상의 후크 시스템을 구축할 수 있습니다.4.1 스트림 JSON 프로토콜 분석gemini --output-format stream-json 명령을 실행하면, 표준 출력(stdout)으로 줄바꿈된 JSON 객체(NDJSON)가 쏟아져 나옵니다. 이 데이터 스트림에서 중요한 이벤트 패턴을 식별해야 합니다.content 이벤트: 모델이 생성하는 텍스트 조각입니다. UI에 실시간 타이핑 효과를 줄 때 사용합니다.toolUse 이벤트: 모델이 도구를 호출하려는 의도를 나타냅니다. (네이티브 후크의 PreToolUse에 해당)turnComplete 이벤트: 모델의 발화 턴이 종료되었음을 알립니다. 이 신호는 모델이 사용자 입력을 기다리는 상태로 전환됨을 의미하므로 알림(Notification) 트리거로 사용하기에 가장 적합합니다.114.2 Python 기반 Gemini 래퍼(GeminiWrapper) 구현이 래퍼는 다음 기능을 수행해야 합니다.subprocess 모듈을 사용하여 Gemini CLI를 자식 프로세스로 실행합니다.별도 스레드에서 자식 프로세스의 stdout을 실시간으로 감시(Polling)합니다.감지된 JSON 이벤트를 파싱하여 미리 등록된 콜백 함수(Hook)를 실행합니다.사용자의 키보드 입력(stdin)을 자식 프로세스로 투명하게 전달하여 대화형 인터페이스를 유지합니다.코드: gemini_hook_runner.pyPythonimport subprocess
import sys
import json
import threading
import os
import platform
import select

class GeminiHookWrapper:
    def __init__(self, command_args):
        self.command = ["gemini", "--output-format", "stream-json"] + command_args
        self.process = None
        self.running = True
        
    def start(self):
        # 1. 프로세스 실행
        # bufsize=0: 버퍼링 없이 즉시 입출력 처리
        # universal_newlines=True: 텍스트 모드로 처리
        self.process = subprocess.Popen(
            self.command,
            stdin=sys.stdin,       # 부모 프로세스의 입력을 그대로 연결
            stdout=subprocess.PIPE, # 출력은 가로채서 분석
            stderr=sys.stderr,      # 에러는 그대로 출력
            text=True,
            bufsize=0
        )
        
        # 2. 출력 감시 스레드 시작
        reader_thread = threading.Thread(target=self._output_reader)
        reader_thread.daemon = True
        reader_thread.start()
        
        # 3. 메인 스레드 대기 (프로세스 종료 시까지)
        try:
            self.process.wait()
        except KeyboardInterrupt:
            self.process.terminate()
        finally:
            self.running = False

    def _output_reader(self):
        """Gemini CLI의 출력을 한 줄씩 읽어 분석하고 후크를 트리거합니다."""
        while self.running:
            # readline은 블로킹 호출이므로 프로세스 종료 시 탈출 로직 주의
            line = self.process.stdout.readline()
            if not line:
                break
            
            self._process_line(line)

    def _process_line(self, line):
        try:
            # JSON 파싱 시도
            event = json.loads(line)
            
            # --- 가상 후크 로직 ---
            
            # 1. Turn Complete 후크 (알림 트리거)
            if event.get('turnComplete') or event.get('type') == 'turnComplete':
                self.on_turn_complete(event)
            
            # 2. Tool Use 후크
            # Gemini 버전에 따라 스키마가 다를 수 있으므로 유연하게 검사
            if 'toolUse' in event or event.get('type') == 'tool_use':
                self.on_tool_use(event)
                
            # 3. 콘텐츠 출력 (사용자에게 보여주기)
            # content 필드가 있는 경우 터미널에 출력
            if 'content' in event:
                sys.stdout.write(event['content'])
                sys.stdout.flush()
                
        except json.JSONDecodeError:
            # JSON이 아닌 일반 텍스트가 섞여 나올 경우 그대로 출력
            sys.stdout.write(line)
            sys.stdout.flush()

    # --- 사용자 정의 후크 메서드 ---

    def on_turn_complete(self, payload):
        """모델 응답 완료 시 실행"""
        # 여기서 OS별 알림 함수 호출
        send_notification("Gemini CLI", "작업이 완료되었습니다. 입력을 기다립니다.")

    def on_tool_use(self, payload):
        """도구 사용 감지 시 실행"""
        tool_name = payload.get('toolUse', {}).get('name', 'Unknown')
        # 예: 로깅
        with open("gemini_tool_log.txt", "a") as f:
            f.write(f"Tool Used: {tool_name}\n")

# --- 크로스 플랫폼 알림 함수 ---
def send_notification(title, message):
    system = platform.system()
    try:
        if system == "Darwin": # macOS
            # 따옴표 이스케이프 처리
            safe_msg = message.replace('"', '\\"')
            cmd = f"""osascript -e 'display notification "{safe_msg}" with title "{title}"'"""
            os.system(cmd)
        elif system == "Linux":
            safe_msg = message.replace("'", "'\\''")
            os.system(f"notify-send '{title}' '{safe_msg}'")
        elif system == "Windows":
            # PowerShell BurntToast 호출
            ps_cmd = f"New-BurntToastNotification -Text '{title}', '{message}'"
            subprocess.run(["powershell", "-Command", ps_cmd], capture_output=True)
    except Exception as e:
        print(f"Notification Error: {e}", file=sys.stderr)

if __name__ == "__main__":
    # 스크립트 실행 시 추가 인자를 Gemini에게 전달
    # 예: python gemini_hook.py -p "Hello"
    wrapper = GeminiHookWrapper(sys.argv[1:])
    wrapper.start()
4.3 래퍼 아키텍처의 한계와 해결책입력 처리 문제: 위 코드는 stdin=sys.stdin으로 직접 연결했지만, Python 스크립트를 통해 입력을 중재(Interpose)하려 할 경우 버퍼링 문제가 발생할 수 있습니다. 이를 해결하기 위해 pty 모듈(Unix 전용)을 사용하거나 pywin32(Windows)를 사용하여 가상 터미널을 구현해야 할 수도 있습니다.13스키마 변경: Gemini CLI는 활발히 업데이트 중이므로 JSON 출력 형식이 변경될 수 있습니다. _process_line 메서드에서 예외 처리를 강화하여 래퍼가 비정상 종료되지 않도록 방어적인 코딩이 필요합니다.차단(Blocking)의 어려움: 네이티브 후크와 달리, 스트림을 읽는 시점에는 이미 도구 실행 명령이 내부적으로 처리되고 있을 수 있습니다. 따라서 이 방식은 '보안 차단'보다는 '모니터링'과 '알림'에 최적화되어 있습니다. 보안이 중요하다면 Gemini 실행 권한 자체를 제한된 샌드박스 환경으로 격리해야 합니다.5. 크로스 플랫폼 알림(Notification) 인프라 구축Claude Code의 command 후크나 Gemini 래퍼의 send_notification 함수에서 실제로 호출될 OS별 명령어에 대한 심층 가이드입니다.5.1 macOS: osascript (AppleScript) 마스터하기macOS의 알림 센터는 osascript를 통해 제어합니다. 단순한 텍스트 알림을 넘어 소리와 부제목을 활용할 수 있습니다.기본 구문:Bashosascript -e 'display notification "내용" with title "제목"'
고급 구문 (소리 및 자막 포함):Bashosascript -e 'display notification "린팅 오류가 발견되었습니다." with title "Claude Code" subtitle "PostToolUse Hook" sound name "Basso"'
사용 가능한 시스템 사운드: /System/Library/Sounds 디렉토리에 있는 Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink.주의사항: AppleScript 문자열 내부에서 쌍따옴표(")를 사용할 경우 반드시 백슬래시(\)로 이스케이프해야 합니다. Bash 변수를 주입할 때는 printf %q 등을 활용하여 안전하게 처리해야 스크립트 오류를 방지할 수 있습니다.155.2 Linux: notify-send 및 데스크톱 환경 통합Linux는 libnotify 표준을 따르므로 notify-send 명령어가 대부분의 배포판(Ubuntu, Fedora, Arch 등)에서 작동합니다.기본 구문:Bashnotify-send "제목" "내용"
고급 구문 (긴급도 및 아이콘):Bashnotify-send -u critical -t 0 -i terminal "Claude Code" "치명적인 오류 발생: 프로세스 중단됨"
-u critical: 긴급도를 '치명적'으로 설정합니다. 많은 데스크톱 환경에서 이 알림은 사용자가 클릭하여 닫을 때까지 사라지지 않습니다.-t 0: 알림 표시 시간을 무한대로 설정합니다 (밀리초 단위, 0은 무한).-i terminal: 알림 좌측에 표시할 아이콘 이름을 지정합니다. /usr/share/icons 경로의 아이콘 이름을 사용할 수 있습니다.175.3 Windows: PowerShell 및 BurntToastWindows의 cmd.exe는 네이티브 알림 명령어가 없습니다. PowerShell의 커뮤니티 모듈인 BurntToast를 사용하는 것이 표준입니다.설치 (관리자 권한 PowerShell):PowerShellInstall-Module -Name BurntToast -Scope CurrentUser -Force
기본 구문 (PowerShell):PowerShellNew-BurntToastNotification -Text "Claude Code", "작업이 완료되었습니다."
WSL(Windows Subsystem for Linux)에서의 호출:대부분의 AI 도구 사용자는 WSL 환경에서 작업합니다. WSL 내부에서 Windows 알림을 띄우려면 powershell.exe를 호출해야 합니다.Bash# ~/.claude/settings.json 내의 command 예시
"command": "powershell.exe -Command \"Import-Module BurntToast; New-BurntToastNotification -Text 'Claude Code', '입력 대기 중' -Sound 'SMS'\""
이 방식은 WSL 프로세스에서 Windows 호스트 프로세스를 실행하므로 약간의 지연이 발생할 수 있지만, 가장 확실한 방법입니다.195.4 통합 Python 솔루션 (plyer)OS를 감지하여 분기 처리를 하는 것이 번거롭다면, Python의 plyer 라이브러리를 사용하는 전용 스크립트를 작성하여 모든 도구에서 공통으로 호출할 수 있습니다.스크립트: ~/.claude/hooks/universal_notify.pyPythonfrom plyer import notification
import sys

# 명령행 인자로 제목과 메시지 받기
title = sys.argv[1] if len(sys.argv) > 1 else "AI Agent"
message = sys.argv[2] if len(sys.argv) > 2 else "Notification"

notification.notify(
    title=title,
    message=message,
    app_name='Claude Code',
    timeout=10,
    # Windows용 아이콘 설정 (옵션)
    # app_icon='path/to/icon.ico' 
)
이 스크립트는 Claude Code의 settings.json이나 Gemini 래퍼에서 python universal_notify.py "Title" "Msg" 형태로 간편하게 호출할 수 있습니다.216. 고급 응용: 외부 연동 및 데이터 로깅로컬 알림을 넘어, 팀 협업 도구로 에이전트의 상태를 전송하거나 활동 로그를 기록하는 고급 패턴입니다.6.1 슬랙(Slack) 웹훅 연동장시간 실행되는 작업(예: 대규모 마이그레이션)의 경우, 완료 시 스마트폰으로 알림을 받고 싶을 수 있습니다.스크립트: ~/.claude/hooks/slack_notify.shBash#!/bin/bash
WEBHOOK_URL="https://hooks.slack.com/services/T000/B000/XXXX"
MESSAGE=$1

curl -X POST -H 'Content-type: application/json' \
--data "{\"text\":\"🤖 Claude Code: $MESSAGE\"}" \
"$WEBHOOK_URL"
Claude 설정:JSON"hooks": {
  "Stop": [
    {
      "matcher": "",
      "hooks": [
        { "type": "command", "command": "bash ~/.claude/hooks/slack_notify.sh '세션이 종료되었습니다.'" }
      ]
    }
  ]
}
6.2 SQLite를 이용한 활동 감사(Audit) 로깅기업 환경에서는 AI가 어떤 파일을 수정했는지 추적해야 할 필요가 있습니다. PostToolUse 훅을 사용하여 모든 파일 변경 내역을 로컬 DB에 기록합니다.Python 스크립트 요약 (audit_log.py):Pythonimport sqlite3
import sys
import json
from datetime import datetime

# DB 초기화
conn = sqlite3.connect('~/.claude/audit.db')
c = conn.cursor()
c.execute('''CREATE TABLE IF NOT EXISTS logs 
             (date text, tool text, args text, result text)''')

# 페이로드 읽기
payload = json.loads(sys.stdin.read())

# 로그 삽입
c.execute("INSERT INTO logs VALUES (?,?,?,?)", 
          (datetime.now(), payload['tool'], json.dumps(payload['args']), json.dumps(payload['result'])))
conn.commit()
이 시스템을 구축하면 "지난주에 AI가 config.yaml을 언제 수정했지?"와 같은 질문에 SQL 쿼리로 답할 수 있습니다.7. 결론 및 제언Claude Code와 Gemini CLI의 후크 및 알림 시스템은 단순한 편의 기능을 넘어, AI 에이전트를 안정적이고 통제 가능한 엔지니어링 리소스로 전환하는 핵심 기술입니다.Claude Code 사용자: 즉시 프로젝트 레벨(settings.json)에 **보안 필터(PreToolUse)**와 **자동 포맷터(PostToolUse)**를 적용하십시오. 이는 팀의 코드 품질을 유지하고 AI의 환각으로 인한 사고를 예방하는 가장 저렴하고 확실한 보험입니다.Gemini CLI 사용자: 아직 네이티브 후크가 없으므로, Python 래퍼 아키텍처를 도입하여 팀 내부 표준 실행 스크립트로 배포하십시오. 특히 turnComplete 이벤트를 감지하여 알림을 보내는 기능은 개발자의 대기 시간을 획기적으로 줄여줄 것입니다.인프라 구축: OS 파편화를 해결하기 위해 plyer 기반의 Python 알림 스크립트나 WSL 호환 PowerShell 호출 방식을 표준화하여 사용하십시오.이 가이드에서 제공된 코드와 아키텍처 패턴을 기반으로, 귀하의 AI 개발 환경을 수동적인 '채팅'에서 능동적인 '오케스트레이션'으로 업그레이드하시기 바랍니다.