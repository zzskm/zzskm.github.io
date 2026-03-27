# GAS(Gameplay Ability System, 개스, 게임플레이 어빌리티 시스템) 기초

> 카테고리 3: 게임플레이 프레임워크 | 섹션 6/6
> 토픽 수: 2개 | 예상 학습 시간: 3시간

---

## 토픽 15: GameplayTag(게임플레이 태그, 계층형 의미 태그) 시스템

> 난이도: ★★☆ | 예상 시간: 1시간 | 선행: 없음

### 1. 핵심 개념

GameplayTag(게임플레이 태그, 계층형 의미 태그)는 문자열처럼 보이지만 실제로는 계층적 의미 체계를 가진 식별자 시스템이다. `Character.State.Stunned`, `Ability.Fire`, `UI.Menu.Inventory`처럼 태그를 계층적으로 정의해 상태, 능력, 분류를 데이터 기반으로 표현한다. 핵심은 enum을 계속 늘리는 대신 확장 가능한 의미 체계를 만든다는 점이다.

태그 설계에서 중요한 것은 규칙과 일관성이다. 태그가 많아질수록 네이밍 규칙, 상위 카테고리, native tag 관리가 없으면 검색성과 재사용성이 빠르게 무너진다.

### 2. 코드 예시

```cpp
FGameplayTag StunTag = FGameplayTag::RequestGameplayTag(TEXT("Character.State.Stunned"));

FGameplayTagContainer StateTags;
StateTags.AddTag(StunTag);

if (StateTags.HasTag(StunTag))
{
    UE_LOG(LogTemp, Warning, TEXT("Character is stunned"));
}
```

### 3. 왜 중요한가 (게임/UE5 맥락)

상태와 조건 조합이 늘어날수록 bool과 enum만으로는 확장성이 떨어진다. GameplayTag는 GAS뿐 아니라 AI, UI 필터링, 액션 잠금, 데이터 분류까지 공통 언어로 쓰이기 좋다.

### 4. 면접 예상 Q&A

**Q1: GameplayTag(게임플레이 태그, 계층형 의미 태그)가 enum보다 나은 점은 무엇인가요?**
> A: 계층 구조와 데이터 기반 확장이 쉽다는 점이다. 새 태그를 추가할 때 코드 수정 범위를 줄일 수 있어 콘텐츠가 많은 프로젝트에 유리하다.

**Q2: `HasTag`와 `HasAny` 같은 질의가 중요한 이유는 무엇인가요?**
> A: 태그 시스템은 단일 값 비교보다 집합 연산이 핵심이기 때문이다. 상태 조합, 차단 조건, 허용 조건을 유연하게 표현할 수 있다.

**Q3: 태그 네이밍 규칙은 왜 중요하나요?**
> A: 이름이 곧 의미 체계이기 때문이다. 계층이 일관되지 않으면 검색, 재사용, 협업이 모두 어려워진다.

**Q4: GameplayTag를 어디까지 확장해 쓰는 편이 좋나요?**
> A: 상태, 능력, 카테고리, UI 필터처럼 의미 분류에는 좋지만 수치 데이터 자체까지 태그로 대체하면 안 된다. 태그는 의미, 숫자는 별도 데이터가 맡아야 한다.

**Q5: native gameplay tag는 언제 고려하나요?**
> A: 핵심 시스템 태그를 코드에서 안정적으로 선언하고 싶을 때다. 문자열 오타 위험을 줄이고 코드 검색성도 좋아진다.

**Q6: 실무에서 태그 시스템이 망가지는 대표 원인은 무엇인가요?**
> A: 즉흥적인 문자열 추가와 중복 의미의 태그 남발이다. 태그는 자유도가 높은 만큼 관리 규칙이 더 중요하다.

### 5. 흔한 실수

- 태그를 문자열 상수처럼 여기저기 흩뿌린다.
- 태그 하나로 상태와 수치와 정책을 모두 표현하려 든다.
- 상위 카테고리 없이 평평한 태그를 무분별하게 늘린다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/GameplayTags/Classes/GameplayTagContainer.h`
- `Engine/Source/Runtime/GameplayTags/Classes/NativeGameplayTags.h`
- `Engine/Source/Runtime/GameplayTags/Private/GameplayTagsManager.cpp`

### 7. 연관 토픽

- 토픽 16: GAS 개요
- 토픽 13: AI - Behavior Tree & EQS
- 카테고리 2 / 토픽 12: UE5 문자열 체계

---

## 토픽 16: GAS(Gameplay Ability System, 개스, 게임플레이 어빌리티 시스템) 개요

> 난이도: ★★★ | 예상 시간: 2시간 | 선행: 토픽 15

### 1. 핵심 개념

GAS(Gameplay Ability System, 개스, 게임플레이 어빌리티 시스템)는 능력 발동, 수치 변화, 상태 효과, 쿨다운, 코스트, 태그 조건을 통합 관리하는 프레임워크다. 중심 구성요소는 `AbilitySystemComponent`, `GameplayAbility`, `GameplayEffect`, `AttributeSet`, `GameplayCue`다. 쉽게 말해 GAS는 스킬과 버프를 규칙 엔진처럼 다루는 구조다.

또한 GAS는 네트워크 예측과 잘 결합된다. 즉 클라이언트는 입력 반응성을 확보하고, 서버는 권위 있는 결과를 확정한다. 그래서 단순 스킬 호출 시스템보다 개념이 많지만, 복잡한 전투 규칙에서는 오히려 구조가 명확해진다.

### 2. 코드 예시

```cpp
UCLASS()
class AMyAbilityCharacter : public ACharacter, public IAbilitySystemInterface
{
    GENERATED_BODY()

public:
    virtual UAbilitySystemComponent* GetAbilitySystemComponent() const override
    {
        return AbilitySystemComponent;
    }

private:
    UPROPERTY()
    TObjectPtr<UAbilitySystemComponent> AbilitySystemComponent;
};
```

### 3. 왜 중요한가 (게임/UE5 맥락)

스킬 수가 많고, 버프/디버프와 수치 계산, 조건 태그, 네트워크 동기화가 복잡한 프로젝트에서는 자체 구현보다 GAS가 더 안정적일 수 있다. 반대로 작은 프로젝트에는 설정과 학습 비용이 과할 수 있으므로 도입 기준을 설명할 수 있어야 한다.

### 4. 면접 예상 Q&A

**Q1: GAS의 핵심 구성요소를 설명해 보세요.**
> A: `AbilitySystemComponent`가 중심 컨테이너, `GameplayAbility`가 실행 가능한 능력, `GameplayEffect`가 상태 변화, `AttributeSet`이 수치 저장소, `GameplayCue`가 연출 반응을 담당한다. 태그는 이들을 연결하는 공통 언어다.

**Q2: `GameplayAbility`와 `GameplayEffect`는 어떻게 다르나요?**
> A: `GameplayAbility`는 발동 가능한 행위이고, `GameplayEffect`는 적용되는 결과다. 결론적으로 "무엇을 할지"와 "어떤 변화를 줄지"를 분리한 구조다.

**Q3: GAS에서 쿨다운과 코스트는 왜 효과로 다루는 경우가 많나요?**
> A: 지속 시간, 스택, 태그 조건, 네트워크 동기화와 자연스럽게 연결되기 때문이다. 즉 별도 임시 변수보다 시스템 안에서 일관되게 관리하기 좋다.

**Q4: `GameplayCue`는 어떤 역할을 하나요?**
> A: 능력이나 효과에 대한 시각, 사운드, 이펙트 반응을 분리하는 역할이다. 게임 규칙과 연출을 분리해 유지보수성을 높인다.

**Q5: prediction은 왜 중요한가요?**
> A: 네트워크 게임에서 입력 반응성을 확보하기 위해서다. 클라이언트가 즉시 피드백을 보여 주고 서버가 나중에 확정하는 흐름이 없으면 능력 사용감이 무거워진다.

**Q6: 어떤 프로젝트에서 GAS 도입이 과할 수 있나요?**
> A: 능력 수가 적고 효과 조합이 단순한 프로젝트다. 이런 경우 GAS의 학습 비용과 설정 복잡성이 이점보다 클 수 있다.

### 5. 흔한 실수

- GAS를 단순 스킬 함수 집합으로 이해한다.
- 연출과 규칙을 분리하지 않아 `GameplayCue`를 활용하지 않는다.
- 코스트, 쿨다운, 태그 조건을 시스템 밖 임시 변수로 따로 관리해 일관성을 잃는다.

### 6. UE5 소스 참고 경로

- `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/AbilitySystemComponent.h`
- `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayAbility.h`
- `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/GameplayEffect.h`
- `Engine/Plugins/Runtime/GameplayAbilities/Source/GameplayAbilities/Public/AttributeSet.h`

### 7. 연관 토픽

- 토픽 15: GameplayTag 시스템
- 토픽 11: 데이터 에셋 & 테이블
- 카테고리 2 / 토픽 16: 다이나믹 델리게이트
