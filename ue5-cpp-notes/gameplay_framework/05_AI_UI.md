# AI & UI

> 카테고리 3: 게임플레이 프레임워크 | 섹션 5/6
> 토픽 수: 2개 | 예상 학습 시간: 3시간

---

## 토픽 13: AI - Behavior Tree & EQS(에이아이 / 비헤이비어 트리 / 이큐에스, 인공지능 / 행동 트리 / 환경 질의 시스템)

> 난이도: ★★★ | 예상 시간: 2시간 | 선행: 토픽 8

### 1. 핵심 개념

UE5 AI의 기본 축은 `AIController(에이아이 컨트롤러, AI 제어기)`, `Behavior Tree(비헤이비어 트리, 행동 트리)`, `Blackboard(블랙보드, 공유 상태 저장소)`, `EQS(이큐에스, 환경 질의 시스템)`, `AIPerception(에이아이 퍼셉션, AI 감지 시스템)`이다. Behavior Tree는 의사결정 흐름, Blackboard는 공유 메모리, EQS는 후보 위치나 대상을 평가하는 질의 시스템, AIPerception은 감지 입력 계층으로 이해하면 정리된다.

즉 AI는 "감지 -> 판단 -> 행동" 파이프라인으로 보는 것이 좋다. 감지는 `AIPerception`, 판단은 Behavior Tree와 `BTService`, 위치 탐색은 EQS, 실제 실행은 Task가 맡는 구조다.

### 2. 코드 예시

```cpp
UCLASS()
class AMyAIController : public AAIController
{
    GENERATED_BODY()

protected:
    virtual void OnPossess(APawn* InPawn) override
    {
        Super::OnPossess(InPawn);
        RunBehaviorTree(BehaviorTreeAsset);
    }

    UPROPERTY(EditDefaultsOnly)
    TObjectPtr<UBehaviorTree> BehaviorTreeAsset;
};
```

### 3. 왜 중요한가 (게임/UE5 맥락)

AI는 상태가 많고 외부 자극에 반응해야 하므로 코드 한 파일에 `if` 문으로 계속 추가하면 빠르게 무너진다. Behavior Tree와 EQS를 이해하면 판단 로직을 데이터와 구조로 분리할 수 있다.

### 4. 면접 예상 Q&A

**Q1: Blackboard와 Behavior Tree는 어떤 관계인가요?**
> A: Behavior Tree가 의사결정 흐름이라면 Blackboard는 그 흐름이 읽고 쓰는 공유 데이터 저장소다. 결론적으로 트리는 규칙, 블랙보드는 상태다.

**Q2: EQS는 언제 유용한가요?**
> A: 엄폐물 위치, 최적 사격 지점, 가장 적절한 목표처럼 후보를 평가해야 할 때 유용하다. 단순 최근접 탐색보다 조건이 많아질수록 장점이 커진다.

**Q3: `BTService`는 어떤 역할을 하나요?**
> A: 주기적으로 감지나 상태 갱신을 수행해 Blackboard 값을 업데이트하는 역할에 가깝다. 트리의 각 Task 안에서 중복 계산하던 로직을 분리할 수 있다.

**Q4: `AIPerception`을 Behavior Tree와 같이 쓰는 이유는 무엇인가요?**
> A: 감지 이벤트를 받아 Blackboard를 갱신하면 판단 로직이 더 명확해지기 때문이다. 즉 감지와 판단 책임을 분리할 수 있다.

**Q5: Behavior Tree가 모든 AI에 정답은 아닌 이유는 무엇인가요?**
> A: 매우 단순한 AI에는 오히려 설정 비용이 클 수 있다. 상태 수와 확장 가능성을 보고 구조를 선택해야 한다.

**Q6: 실무에서 AI 디버깅의 핵심은 무엇인가요?**
> A: 현재 Blackboard 값, 실행 중인 트리 노드, 감지 상태를 동시에 보는 것이다. 많은 문제는 알고리즘보다 상태 갱신 누락에서 발생한다.

### 5. 흔한 실수

- 감지, 판단, 행동을 한 Task 안에 몰아 넣는다.
- Blackboard 키 설계를 대충 해서 의미가 겹치고 추적이 어려워진다.
- EQS를 과하게 남용해 단순 탐색에도 불필요한 비용을 쓴다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/AIModule/Classes/AIController.h`
- `Engine/Source/Runtime/AIModule/Classes/BehaviorTree/BehaviorTree.h`
- `Engine/Source/Runtime/AIModule/Classes/BehaviorTree/BTService.h`
- `Engine/Source/Runtime/AIModule/Classes/Perception/AIPerceptionComponent.h`

### 7. 연관 토픽

- 토픽 8: 충돌 & 피직스
- 토픽 9: Actor 간 통신
- 토픽 16: GAS 개요

---

## 토픽 14: UMG(유엠지, 언리얼 UI) UI 기초

> 난이도: ★★☆ | 예상 시간: 1시간 | 선행: 토픽 10

### 1. 핵심 개념

UMG(유엠지, 언리얼 UI) UI의 핵심은 위젯 생성보다 "데이터 흐름과 수명 관리"다. `CreateWidget`, `AddToViewport`, 바인딩, 입력 포커스, `NativeConstruct(네이티브 컨스트럭트, 위젯 초기 구성 시점)`, `NativeDestruct(네이티브 디스트럭트, 위젯 정리 시점)`를 같이 이해해야 실제 UI가 안정적으로 동작한다.

또한 단순 UMG 위젯을 넘어서 Common UI 같은 프레임워크는 입력 라우팅, 화면 스택, 플랫폼 대응을 체계화한다. 즉 UI는 그리기보다 상태와 입력 관리 문제에 가깝다.

### 2. 코드 예시

```cpp
void AMyHUD::ShowMainMenu()
{
    if (!MainMenuWidget && MainMenuClass)
    {
        MainMenuWidget = CreateWidget<UUserWidget>(GetWorld(), MainMenuClass);
    }

    if (MainMenuWidget)
    {
        MainMenuWidget->AddToViewport();
    }
}
```

### 3. 왜 중요한가 (게임/UE5 맥락)

메뉴, HUD, 인벤토리, 퀘스트, 알림은 모두 UI와 연결된다. 게임플레이 로직보다 덜 중요해 보이지만, 입력 충돌과 수명 누수는 사용자 체감에 바로 드러난다.

### 4. 면접 예상 Q&A

**Q1: `NativeConstruct`와 생성자는 어떻게 다르게 봐야 하나요?**
> A: 생성자는 UObject 생성 시점이고, `NativeConstruct`는 위젯이 실제로 구성되어 화면 생명주기에 들어오는 시점이다. UI 바인딩과 외부 연결은 보통 `NativeConstruct`가 더 적절하다.

**Q2: `NativeDestruct`에서 무엇을 정리해야 하나요?**
> A: 델리게이트 바인딩, 타이머, 외부 서비스 구독 같은 연결성 자원을 정리해야 한다. 이유는 위젯은 화면에서 사라져도 객체가 잠시 남아 있을 수 있기 때문이다.

**Q3: 바인딩 기반 UI는 왜 과하면 안 되나요?**
> A: 편하지만 프레임마다 평가되거나 갱신 흐름이 불명확해질 수 있다. 자주 바뀌지 않는 값은 이벤트 기반 갱신이 더 명확하고 효율적이다.

**Q4: Common UI를 고려할 만한 상황은 언제인가요?**
> A: 메뉴 스택, 입력 포커스, 플랫폼별 버튼 힌트, 화면 전환 규칙이 복잡한 프로젝트다. 규모가 커질수록 단순 UMG 조합보다 장점이 커진다.

**Q5: UI 로직은 `PlayerController`, `HUD`, 위젯 중 어디에 두는 것이 좋나요?**
> A: 입력과 화면 전환 제어는 `PlayerController`나 UI 매니저, 순수 표현은 위젯에 두는 편이 일반적이다. 위젯 자체가 게임 규칙을 소유하게 만들면 테스트와 재사용이 어려워진다.

**Q6: 실무에서 UI 수명 버그는 어떻게 나타나나요?**
> A: 화면은 닫혔는데 이전 위젯이 이벤트를 계속 받거나, 새 레벨에서 오래된 위젯 참조가 남아 중복 갱신이 일어나는 식으로 드러난다. 대부분 정리 누락 문제다.

### 5. 흔한 실수

- 위젯 안에 게임 규칙까지 넣어 책임이 비대해진다.
- `NativeConstruct`에서 바인딩하고 `NativeDestruct`에서 해제하지 않는다.
- UI 입력 포커스와 게임플레이 입력 우선순위를 분리하지 않는다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/UMG/Public/Blueprint/UserWidget.h`
- `Engine/Plugins/Runtime/CommonUI/Source/CommonUI/Public/CommonActivatableWidget.h`
- `Engine/Source/Runtime/Slate/Public/Widgets/SWidget.h`

### 7. 연관 토픽

- 토픽 5: Enhanced Input System
- 토픽 10: 블루프린트 & C++ 협업
- 카테고리 2 / 토픽 16: 다이나믹 델리게이트
