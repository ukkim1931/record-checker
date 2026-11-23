# 학생부 점검기

학교생활기록부 문장의 맞춤법·띄어쓰기·기재요령을 점검하는 웹 도구입니다.
- 주소: https://ukkim1931.github.io/record-checker/
- 입력한 글은 브라우저 안에서만 분석되며 어떤 서버로도 전송되지 않습니다(CSP로 외부 요청 차단).
- 분석 엔진: Kiwi(kiwi-nlp), 뜻 검사: KLUE-RoBERTa(CC BY-SA 4.0) + transformers.js(Apache-2.0). 각 라이선스는 lib/ 아래 참고.
