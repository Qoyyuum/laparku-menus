import Ionicons from "@expo/vector-icons/Ionicons";
import { TextInput, View } from "react-native";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder }: Props) {
  return (
    <View className="flex-row items-center gap-2 rounded-xl border border-neutral-300 bg-white px-4 py-1">
      <Ionicons name="search" size={18} color="#a3a3a3" />
      <TextInput
        className="flex-1 py-2 text-base text-neutral-900 outline-none"
        placeholder={placeholder ?? "Search dishes, products, venues…"}
        placeholderTextColor="#a3a3a3"
        value={value}
        onChangeText={onChange}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}
