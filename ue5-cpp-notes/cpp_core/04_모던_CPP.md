# 모던 C++

> 카테고리 1: C++ 핵심 | 섹션 4/8
> 토픽 수: 6개 | 예상 학습 시간: 9시간

---

## 토픽 16: move semantics(무브 세맨틱스, 이동 의미론)

> 난이도: ★★★ | 예상 시간: 2시간 | 선행: 토픽 3, 4

### 1. 핵심 개념

move semantics(무브 세맨틱스, 이동 의미론)는 "복사 대신 자원의 소유권을 옮겨 불필요한 비용을 줄이는 규칙"이다. 핵심은 value categories(값 범주), 즉 `lvalue`, `xvalue`, `prvalue`를 구분하고, rvalue 계열에서 자원을 훔쳐 오는 move constructor와 move assignment를 이해하는 것이다.

`std::move`는 실제로 옮기지 않고 "이 값을 rvalue로 취급해도 된다"는 캐스트에 가깝다. 반면 `std::forward`는 전달받은 값의 value category를 유지하는 데 쓰이며 perfect forwarding 문맥에서 중요하다. 이동 후 객체는 파괴 가능하고 재할당 가능한 유효 상태여야 하지만, 구체 값은 보장되지 않는 moved-from 상태라는 점도 함께 기억해야 한다. 또한 move가 항상 빠른 것은 아니다. 작은 trivially copyable 타입은 복사가 더 단순할 수 있고, `noexcept`가 빠진 move는 컨테이너가 복사를 선택하게 만들기도 한다.

### 2. 코드 예시

```cpp
class Buffer
{
public:
    Buffer(size_t Size) : Size(Size), Data(new int[Size]) {}

    Buffer(Buffer&& Other) noexcept
        : Size(Other.Size), Data(Other.Data)
    {
        Other.Size = 0;
        Other.Data = nullptr;
    }

    Buffer& operator=(Buffer&& Other) noexcept
    {
        if (this != &Other)
        {
            delete[] Data;
            Size = Other.Size;
            Data = Other.Data;
            Other.Size = 0;
            Other.Data = nullptr;
        }
        return *this;
    }

    ~Buffer() { delete[] Data; }

private:
    size_t Size = 0;
    int* Data = nullptr;
};
```

### 3. 왜 중요한가 (게임/UE5 맥락)

문자열, 컨테이너, 리소스 핸들처럼 큰 데이터를 자주 주고받는 게임 코드에서는 복사 비용이 체감된다. move semantics를 이해하면 임시 객체를 더 효율적으로 다루고, 불필요한 할당을 줄이는 설계를 할 수 있다.

### 4. 면접 예상 Q&A

**Q1: move semantics(무브 세맨틱스, 이동 의미론)의 핵심 목적은 무엇인가요?**
> A: 복사 비용이 큰 자원을 소유권 이전으로 처리해 성능을 높이는 것이다. 결론적으로 값 의미는 유지하되 구현 비용을 줄이는 장치다.

**Q2: `std::move`는 실제로 무엇을 하나요?**
> A: 값을 실제로 옮기지 않고 rvalue 참조로 캐스팅한다. 이후 어떤 move 연산이 호출될지는 대상 타입 구현에 달려 있다.

**Q3: `std::move`와 `std::forward`는 어떻게 다르나요?**
> A: `std::move`는 무조건 rvalue 취급이고, `std::forward`는 템플릿 인자로 들어온 value category를 보존한다. perfect forwarding에서는 `std::forward`가 핵심이다.

**Q4: moved-from 객체는 어떤 상태라고 봐야 하나요?**
> A: 파괴와 재할당은 가능하지만 구체적인 값은 보장되지 않는 유효 상태다. 즉 "비어 있다"고 단정하면 안 된다.

**Q5: move constructor와 move assignment는 언제 따로 중요해지나요?**
> A: 새 객체 생성인지, 기존 객체에 덮어쓰는지에 따라 다르다. 특히 assignment는 기존 자원 정리와 self-assignment 방어를 더 신경 써야 한다.

**Q6: perfect forwarding은 왜 필요한가요?**
> A: 호출자가 넘긴 lvalue/rvalue 성격을 잃지 않고 다시 전달하기 위해서다. 래퍼 함수나 팩토리 함수에서 불필요한 복사를 막는 데 중요하다.

**Q7: move가 항상 빠른가요?**
> A: 아니다. 작고 단순한 타입은 복사 비용이 사실상 무시될 수 있고, move 자체도 포인터 교체나 상태 정리가 필요하면 공짜가 아니다. 특히 `noexcept`가 아니면 컨테이너가 안전을 위해 복사를 택할 수도 있어 "move = 무조건 빠름"이라고 말하면 위험하다.

### 5. 흔한 실수

- `std::move`를 호출하면 무조건 값이 이동됐다고 생각한다.
- moved-from 객체를 특정 값 상태로 가정한다.
- move assignment에서 기존 자원 해제를 빼먹는다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/Core/Public/Templates/UnrealTemplate.h`
- `Engine/Source/Runtime/Core/Public/Containers/Array.h`

### 7. 연관 토픽

- 토픽 4: 스마트 포인터
- 토픽 19: 템플릿
- 카테고리 2 / 토픽 12: UE5 문자열 체계

---

## 토픽 17: 람다

> 난이도: ★★☆ | 예상 시간: 1시간 | 선행: 토픽 16

### 1. 핵심 개념

람다는 "이름 없는 함수 객체를 즉석에서 정의하는 문법"이다. 핵심은 캡처 방식이다. 값 캡처는 복사본을 저장하고, 참조 캡처는 외부 변수에 직접 연결된다. `[this]`, `[=]`, `[&]`, 초기화 캡처, `mutable`, generic lambda까지 이해하면 실무 대부분을 커버할 수 있다.

람다는 함수 포인터보다 상태를 들고 다니기 쉽고, `std::algorithm`, 비동기 작업, 델리게이트 바인딩에서 자주 쓰인다. 다만 수명과 캡처 비용을 동시에 생각해야 안전하다.

### 2. 코드 예시

```cpp
int Count = 0;
auto Add = [Count](int Value) mutable
{
    Count += Value;
    return Count;
};

auto Print = [this]()
{
    LogCurrentState();
};

auto GenericAdd = [](auto A, auto B)
{
    return A + B;
};
```

### 3. 왜 중요한가 (게임/UE5 맥락)

컨테이너 처리, 조건 필터링, 비동기 콜백, 델리게이트 바인딩에서 람다는 거의 기본 도구다. 람다를 이해하면 짧은 로직을 구조적으로 표현할 수 있지만, 캡처 실수는 수명 버그로 바로 이어진다.

### 4. 면접 예상 Q&A

**Q1: 값 캡처와 참조 캡처는 어떻게 다르나요?**
> A: 값 캡처는 현재 값을 복사해 보관하고, 참조 캡처는 원본 변수에 연결된다. 결론적으로 수명 안전성은 값 캡처가, 원본 반영은 참조 캡처가 유리하다.

**Q2: `[this]` 캡처는 왜 조심해야 하나요?**
> A: 객체 수명이 람다보다 짧아질 수 있기 때문이다. 비동기 작업이나 지연 실행 람다에서는 특히 dangling 위험이 크다.

**Q3: `mutable`은 언제 필요한가요?**
> A: 값 캡처한 복사본을 람다 내부에서 수정하고 싶을 때 필요하다. 기본적으로 값 캡처는 const처럼 다뤄진다.

**Q4: generic lambda는 어떤 장점이 있나요?**
> A: 별도 템플릿 함수 없이도 다양한 타입을 받는 짧은 함수 객체를 쉽게 만들 수 있다. 알고리즘 보조 로직에 특히 편하다.

**Q5: 즉시 실행 람다는 언제 유용한가요?**
> A: 복잡한 초기화 식을 한 번만 계산해 값을 만들고 싶을 때 유용하다. 지역 스코프를 만들어 초기화 코드를 감출 수 있다.

**Q6: 실무에서 람다 사용이 과하다는 신호는 무엇인가요?**
> A: 캡처 목록이 길어지고 본문이 커져 일반 함수보다 읽기 어려워질 때다. 이때는 이름 있는 함수나 별도 객체로 빼는 편이 낫다.

### 5. 흔한 실수

- 비동기 람다에서 `[this]`를 무심코 캡처한다.
- 값 캡처와 참조 캡처 비용과 수명 차이를 구분하지 않는다.
- 너무 긴 람다를 한 줄 도우미처럼 남겨 가독성을 떨어뜨린다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/Core/Public/Templates/Function.h`
- `Engine/Source/Runtime/Core/Public/Containers/Array.h`

### 7. 연관 토픽

- 토픽 18: std::function & std::bind
- 토픽 21: 멀티스레딩 기초
- 카테고리 2 / 토픽 15: 싱글캐스트 / 멀티캐스트 델리게이트

---

## 토픽 18: std::function & std::bind(에스티디 펑션 / 에스티디 바인드, 호출 래퍼와 인자 바인딩)

> 난이도: ★★☆ | 예상 시간: 1시간 | 선행: 토픽 17

### 1. 핵심 개념

`std::function(에스티디 펑션, 범용 호출 래퍼)`은 호출 가능한 객체를 `type erasure(타입 이레이저, 타입 소거)`로 감싸는 범용 함수 래퍼다. 함수 포인터, 람다, functor를 같은 타입으로 담을 수 있다는 장점이 있지만, 간접 호출과 동적 할당 가능성 때문에 오버헤드가 있다.

`std::bind(에스티디 바인드, 인자 바인딩 도구)`는 함수와 일부 인자를 미리 묶어 새로운 호출 객체를 만드는 도구지만, 가독성이 떨어지고 디버깅이 불편해 현대 C++에서는 람다로 대체하는 경우가 많다. UE5에서는 이와 별개로 델리게이트 시스템이 존재하므로, 엔진 수명과 리플렉션이 걸린 이벤트는 표준 라이브러리보다 델리게이트가 더 적합한 경우가 많다.

### 2. 코드 예시

```cpp
void PrintSum(int A, int B)
{
    std::cout << (A + B) << "\n";
}

std::function<void(int)> Func = [](int Value)
{
    std::cout << Value << "\n";
};

auto Bound = std::bind(PrintSum, 10, std::placeholders::_1);
```

### 3. 왜 중요한가 (게임/UE5 맥락)

콜백을 일반화하고 싶은 순간 `std::function`을 떠올리기 쉽다. 하지만 핫패스, 메모리 비용, 수명 관리, UE 델리게이트와의 경계를 모르면 편해 보이는 추상화가 오히려 문제를 만든다.

### 4. 면접 예상 Q&A

**Q1: `std::function(에스티디 펑션, 범용 호출 래퍼)`의 장점은 무엇인가요?**
> A: 다양한 호출 가능 객체를 하나의 타입으로 다룰 수 있다는 점이다. 인터페이스가 단순해지고 콜백 전달이 편해진다.

**Q2: 타입 소거란 무엇인가요?**
> A: 실제 호출 객체 타입을 감추고 공통 인터페이스로 다루는 기법이다. 결론적으로 유연성은 높지만 런타임 오버헤드가 생길 수 있다.

**Q3: `std::bind`보다 람다가 자주 권장되는 이유는 무엇인가요?**
> A: 캡처와 인자 흐름이 더 읽기 쉽고 디버깅도 낫기 때문이다. `std::bind`는 플레이스홀더가 많아질수록 의도가 흐려진다.

**Q4: `std::function`을 핫패스에서 조심해야 하는 이유는 무엇인가요?**
> A: 간접 호출과 할당 비용 가능성 때문이다. 매우 자주 호출되는 경로에서는 템플릿이나 직접 호출이 더 나을 수 있다.

**Q5: UE 델리게이트와 `std::function`은 어떻게 구분하나요?**
> A: 엔진 객체 수명, 블루프린트, 멀티캐스트 이벤트가 걸리면 UE 델리게이트가 더 적합하다. 순수 C++ 내부 유틸리티 콜백은 `std::function`이 간단할 수 있다.

**Q6: 실무에서 `std::function` 남용의 신호는 무엇인가요?**
> A: 콜백 타입을 단순화하려다 호출 비용과 수명 책임이 흐려질 때다. 특히 반복 호출 경로나 임베디드 상태가 큰 람다에서는 더 조심해야 한다.

### 5. 흔한 실수

- 모든 콜백을 습관적으로 `std::function`으로 감싼다.
- `std::bind` 체인으로 코드 의도를 읽기 어렵게 만든다.
- UE 객체 수명 문제를 `std::function`만으로 해결하려 한다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/Core/Public/Templates/Function.h`
- `Engine/Source/Runtime/Core/Public/Delegates/Delegate.h`

### 7. 연관 토픽

- 토픽 17: 람다
- 토픽 19: 템플릿
- 카테고리 2 / 토픽 15: 싱글캐스트 / 멀티캐스트 델리게이트

---

## 토픽 19: 템플릿

> 난이도: ★★★ | 예상 시간: 2시간 | 선행: 토픽 10

### 1. 핵심 개념

템플릿은 타입이나 값을 파라미터로 받아 컴파일 시점에 코드를 생성하는 메커니즘이다. 함수 템플릿, 클래스 템플릿, 특수화, 부분 특수화, `if constexpr`, SFINAE, 그리고 modern C++에서는 concepts까지 이어진다.

핵심은 "하나의 규칙을 여러 타입에 적용하되, 필요한 제약과 분기를 컴파일 시점에 표현한다"는 점이다. SFINAE는 부적절한 치환을 후보군에서 조용히 제외하는 규칙이고, `if constexpr`는 컴파일 타임 분기를 더 읽기 쉽게 만든다. `enable_if`는 그 제약을 함수 시그니처 쪽에 거는 오래된 실전 도구이고, concepts는 템플릿 제약을 문서처럼 드러내는 현대적 도구다.

### 2. 코드 예시

```cpp
template <typename T>
T MaxValue(T A, T B)
{
    return (A < B) ? B : A;
}

template <typename T>
void PrintValue(const T& Value)
{
    if constexpr (std::is_pointer_v<T>)
    {
        std::cout << *Value << "\n";
    }
    else
    {
        std::cout << Value << "\n";
    }
}

template <typename T, typename = std::enable_if_t<std::is_integral_v<T>>>
T AddOne(T Value)
{
    return Value + 1;
}

template <typename T>
concept HasSize = requires(T Value)
{
    Value.size();
};
```

### 3. 왜 중요한가 (게임/UE5 맥락)

컨테이너, 수학 유틸리티, 타입 트레이트, 엔진 공통 도구는 대부분 템플릿에 기대고 있다. 템플릿을 이해해야 표준 라이브러리와 UE 공용 헤더를 읽을 수 있고, 지나친 매크로 대신 타입 안전한 일반화를 설계할 수 있다.

### 4. 면접 예상 Q&A

**Q1: 템플릿의 가장 큰 장점은 무엇인가요?**
> A: 타입 안전성을 유지하면서 재사용 가능한 일반화 코드를 만들 수 있다는 점이다. 결론적으로 매크로나 void 포인터보다 훨씬 안전한 일반화 도구다.

**Q2: 함수 템플릿과 클래스 템플릿 특수화는 왜 필요한가요?**
> A: 대부분 타입에는 일반 규칙을 쓰되, 특정 타입에는 다른 처리가 필요할 수 있기 때문이다. 특수화는 그 예외를 컴파일 타임에 표현한다.

**Q3: SFINAE를 직관적으로 설명해 보세요.**
> A: 템플릿 치환이 실패하면 컴파일 에러로 바로 터뜨리지 않고 해당 후보를 후보군에서 빼는 규칙이다. 그래서 특정 조건에서만 오버로드가 보이게 만들 수 있다.

**Q4: `if constexpr`가 중요한 이유는 무엇인가요?**
> A: 템플릿 내부에서 타입별 분기를 더 읽기 쉽게 만들기 때문이다. 예전의 복잡한 enable_if 패턴 일부를 훨씬 단순하게 바꿔 준다.

**Q5: concepts는 무엇을 개선하나요?**
> A: 템플릿 제약을 선언적으로 드러내고 에러 메시지를 더 읽기 쉽게 만든다. 즉 "이 템플릿이 어떤 타입을 원하나"를 문서처럼 표현할 수 있다.

**Q6: 템플릿 남용의 위험은 무엇인가요?**
> A: 에러 메시지가 복잡해지고 빌드 시간이 늘어나며, 실제로는 단순 함수면 되는 문제까지 과도하게 일반화할 수 있다. 일반화보다 명확성이 먼저다.

**Q7: `enable_if`는 언제 써 봤다고 말할 수 있나요?**
> A: concepts를 아직 쓸 수 없거나, 기존 코드베이스가 SFINAE 패턴에 맞춰져 있을 때 특정 오버로드를 조건부로 노출하는 용도로 썼다고 설명하면 된다. 예를 들어 정수형일 때만 활성화되는 함수, iterator category별 오버로드, 포인터 타입 전용 헬퍼 같은 경우가 전형적이다.

**Q8: concepts를 사용하는 이유는 무엇인가요?**
> A: 제약을 함수 본문이 아니라 선언부에서 명확히 보여 주고, 템플릿 에러 메시지를 훨씬 읽기 쉽게 만들기 위해서다. 팀 차원에서는 "이 템플릿이 기대하는 인터페이스"를 코드에 직접 문서화하는 효과도 크다.

### 5. 흔한 실수

- 미래 확장을 핑계로 템플릿을 과도하게 일반화한다.
- 제약 없는 템플릿으로 에러 메시지를 난해하게 만든다.
- 구현과 사용 지점을 분리해 템플릿 정의 가시성 문제를 만든다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/Core/Public/Templates/`
- `Engine/Source/Runtime/Core/Public/Traits/`

### 7. 연관 토픽

- 토픽 18: std::function & std::bind
- 토픽 20: STL 컨테이너 & 알고리즘
- 카테고리 1 / 토픽 23: 컴파일 과정

---

## 토픽 20: STL 컨테이너 & 알고리즘(에스티엘, 표준 라이브러리 자료구조와 알고리즘)

> 난이도: ★★☆ | 예상 시간: 1시간 | 선행: 토픽 19

### 1. 핵심 개념

STL(Standard Template Library, 에스티엘, 표준 템플릿 라이브러리)의 핵심은 컨테이너와 알고리즘을 `iterator(이터레이터, 반복자)`로 연결하는 설계다. `vector`, `map`, `unordered_map`, `set`는 용도가 다르고, `sort`, `find_if`, `remove_if`, 범위 기반 for는 이 구조 위에서 동작한다.

실무에서는 "무조건 빠른 컨테이너"가 아니라 접근 패턴과 invalidation 규칙을 먼저 본다. 예를 들어 `vector`는 연속 메모리와 캐시 효율이 강점이지만 삽입/삭제 시 재배치와 iterator invalidation을 신경 써야 한다.

### 2. 코드 예시

```cpp
std::vector<int> Values = {4, 2, 5, 1};
std::sort(Values.begin(), Values.end());

auto It = std::find_if(Values.begin(), Values.end(), [](int V)
{
    return V > 3;
});

for (int Value : Values)
{
    std::cout << Value << "\n";
}
```

### 3. 왜 중요한가 (게임/UE5 맥락)

자료구조 선택은 곧 성능과 유지보수성 선택이다. 게임 코드에서는 컨테이너를 너무 감각적으로 고르면 캐시 미스, 잦은 재할당, 잘못된 순회 삭제 같은 문제가 곧바로 나온다.

### 4. 면접 예상 Q&A

**Q1: `vector`를 기본 선택으로 많이 쓰는 이유는 무엇인가요?**
> A: 연속 메모리와 캐시 효율이 좋고 사용성이 단순하기 때문이다. 특별한 이유가 없으면 `vector`를 먼저 고려하는 경우가 많다.

**Q2: `map`과 `unordered_map`은 어떻게 구분하나요?**
> A: 정렬된 순서와 안정적 트리 성질이 필요하면 `map`, 평균 O(1) 해시 조회가 중요하면 `unordered_map`이다. 키 분포와 순서 요구가 판단 기준이다.

**Q3: iterator invalidation은 왜 중요하나요?**
> A: 삽입, 삭제, 재할당 뒤에 기존 iterator나 reference가 무효가 될 수 있기 때문이다. 컨테이너 종류마다 규칙이 달라 버그 원인이 되기 쉽다.

**Q4: `remove_if`가 실제 삭제가 아니라는 말은 무슨 뜻인가요?**
> A: 조건에 맞는 원소를 뒤로 몰아 logical end를 반환할 뿐, 컨테이너 크기를 줄이지는 않는다. 그래서 erase-remove idiom을 같이 써야 완전 삭제가 된다.

**Q5: 알고리즘을 직접 루프로 쓰지 않고 STL로 쓰는 장점은 무엇인가요?**
> A: 의도가 더 분명해지고 재사용성이 높으며, 잘 알려진 패턴을 안전하게 쓸 수 있기 때문이다. 코드 리뷰와 유지보수 측면에서도 이점이 있다.

**Q6: 실무에서 컨테이너 선택이 틀렸다는 신호는 무엇인가요?**
> A: 검색 패턴과 수정 패턴이 자료구조 특성과 맞지 않아 병목이 반복될 때다. 추상적인 "빅오"보다 실제 접근 패턴을 봐야 한다.

### 5. 흔한 실수

- 컨테이너 invalidation 규칙을 무시한 채 reference를 오래 들고 있다.
- `remove_if`만 호출하고 실제 erase를 하지 않는다.
- 데이터 특성보다 습관대로 `map`이나 `unordered_map`을 선택한다.

### 6. UE5 소스 참고 경로

- 표준 라이브러리 개념이므로 UE 소스보다 `Core` 컨테이너 사용처를 참고
- `Engine/Source/Runtime/Core/Public/Containers/Array.h`

### 7. 연관 토픽

- 토픽 17: 람다
- 토픽 19: 템플릿
- 카테고리 2 / 토픽 13: UE5 컨테이너

---

## 토픽 21: 멀티스레딩 기초

> 난이도: ★★★ | 예상 시간: 2시간 | 선행: 토픽 5

### 1. 핵심 개념

멀티스레딩은 여러 실행 흐름이 동시에 데이터를 다루는 환경이다. 기본 도구는 `std::thread`, `std::mutex`, `std::lock_guard`, `std::atomic`, `std::condition_variable`이며, 핵심 위험은 race condition과 deadlock이다.

또한 atomic이라고 해서 모든 동기화가 해결되는 것은 아니다. 원자성은 한 연산의 찢어짐을 막아 주지만, 여러 변수 간 일관성까지 자동으로 보장하지는 않는다. `std::memory_order(에스티디 메모리 오더, 메모리 순서 규칙)`는 원자 연산의 가시성과 순서를 제어하는 규칙이며, 기본값인 `seq_cst`는 가장 강한 직관을 제공하고, `acquire/release`는 더 느슨하지만 자주 쓰이는 패턴이다.

### 2. 코드 예시

```cpp
std::mutex Mutex;
int Counter = 0;

void Increase()
{
    std::lock_guard<std::mutex> Lock(Mutex);
    ++Counter;
}
```

### 3. 왜 중요한가 (게임/UE5 맥락)

로딩, 리소스 준비, 백그라운드 계산, 렌더링 파이프라인 보조 작업은 멀티스레딩과 닿는다. 게임에서는 성능을 위해 스레드를 쓰지만, 잘못 쓰면 재현 어려운 버그와 데드락이 생겨 디버깅 비용이 크게 뛴다.

### 4. 면접 예상 Q&A

**Q1: race condition은 무엇인가요?**
> A: 여러 스레드가 같은 데이터에 동시에 접근해 결과가 실행 순서에 따라 달라지는 문제다. 결론적으로 공유 상태와 동기화 부족이 핵심 원인이다.

**Q2: `mutex`와 `atomic`은 어떻게 구분하나요?**
> A: 복합 상태 보호나 긴 임계 구역이면 `mutex`, 단순한 원자 변수 연산이면 `atomic`이 적절하다. atomic은 더 가볍지만 표현 범위가 좁다.

**Q3: `lock_guard`를 왜 쓰나요?**
> A: RAII로 락 해제를 자동화해 예외나 조기 반환에서도 안전하게 해제하기 위해서다. 수동 `lock/unlock`보다 훨씬 안전하다.

**Q4: deadlock은 어떻게 생기나요?**
> A: 여러 락을 서로 다른 순서로 잡거나, 해제되지 않는 대기 상태가 순환할 때 생긴다. 락 순서 규칙과 락 범위 축소가 대표 예방책이다.

**Q5: `memory_order_seq_cst`와 `acquire/release`를 직관적으로 비교해 보세요.**
> A: `seq_cst`는 모두가 같은 순서를 본다고 생각하기 쉬운 가장 강한 규칙이고, `acquire/release`는 필요한 가시성만 보장해 더 유연하다. 기본 개념이 약하면 먼저 `seq_cst`로 이해하고 이후 최적화 관점에서 `acquire/release`를 보는 편이 안전하다.

**Q6: 실무에서 멀티스레딩 문제를 줄이는 가장 좋은 방법은 무엇인가요?**
> A: 공유 상태 자체를 줄이고 메시지 전달이나 작업 분할로 구조를 단순화하는 것이다. 동기화 기술보다 공유를 줄이는 설계가 더 강력하다.

### 5. 흔한 실수

- atomic 하나로 복합 상태 일관성까지 해결된다고 생각한다.
- 여러 락을 제각각 순서로 획득한다.
- 락 범위를 필요 이상으로 넓혀 성능과 교착 가능성을 키운다.

### 6. UE5 소스 참고 경로

- `Engine/Source/Runtime/Core/Public/HAL/ThreadSafeBool.h`
- `Engine/Source/Runtime/Core/Public/HAL/CriticalSection.h`
- `Engine/Source/Runtime/Core/Public/Async/`

### 7. 연관 토픽

- 토픽 17: 람다
- 카테고리 1 / 토픽 1: 스택 vs 힙
- 카테고리 8: 엔진 구조 & 빌드 시스템 심화
