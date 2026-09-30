/**
 * 앱이 여는 공식 웹사이트 주소.
 * 사이트를 solhun.com → climanager.solhun.com 으로 옮길 때 이 한 곳만 바꾼다.
 * (이전 절차: solhun-web-page 저장소 docs/domain-migration-climanager.md)
 *
 * 이미 배포된 구버전 앱은 옛 주소를 계속 열기 때문에, 옛 도메인의 301 리디렉트는
 * 이 값을 바꾼 뒤에도 유지해야 한다.
 */
// 2026-09-30 이전 완료: solhun.com 은 개인 포트폴리오가 됐고, 옛 /changelog 는 거기서 301 로 이 주소에 온다.
export const WEBSITE_URL = 'https://climanager.solhun.com'

export const CHANGELOG_URL = `${WEBSITE_URL}/changelog`
